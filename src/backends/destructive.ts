import type { ApprovalRequest } from './types';

/**
 * Host-free recognition of commands whose ordinary effect is destructive.
 *
 * The classifier is deliberately conservative and small: it names the risk the
 * command carries (recursive delete, force push, hard reset, database drop, or
 * a user pattern) so the approval layer can force a decision even when a broad
 * stored rule would otherwise answer silently. It never executes, writes, or
 * reads anything, and its reason contains only the (bounded) command text.
 */

export type DestructiveCategory =
  | 'recursive-delete'
  | 'force-push'
  | 'hard-reset'
  | 'database-drop'
  | 'custom';

export interface DestructiveMatch {
  category: DestructiveCategory;
  /** Plain risk label, suitable for a prompt title or reason. */
  label: string;
  /** Plain-language risk plus the exact (bounded) command. */
  reason: string;
}

/** Longest command excerpt shown in an approval reason. */
export const PROMPT_COMMAND_LIMIT = 200;

const REDACTED = '<redacted>';

const LABELS: Record<DestructiveCategory, string> = {
  'recursive-delete': 'recursive delete',
  'force-push': 'force push',
  'hard-reset': 'hard reset',
  'database-drop': 'database drop',
  custom: 'custom destructive pattern'
};

const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
  'timeout',
  'xargs',
  'stdbuf',
  'setsid',
  'unbuffer'
]);

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

/** Commands that accept SQL on their own argv; only these may trigger a DB drop. */
const DATABASE_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'mongosh',
  'mongo',
  'sqlite3',
  'sqlcmd',
  'clickhouse-client',
  'sqlplus'
]);

/** PowerShell flags that consume the following token. */
const POWERSHELL_VALUE_FLAGS = new Set([
  '-executionpolicy',
  '-windowstyle',
  '-inputformat',
  '-outputformat',
  '-configurationname',
  '-version',
  '-psconsolefile'
]);

const SHELL_VALUE_FLAGS = new Set([
  '-u',
  '-g',
  '-p',
  '-C',
  '-h',
  '-r',
  '-t',
  '-U',
  '-D',
  '-R',
  '-T',
  '--user',
  '--group',
  '--prompt',
  '--chdir',
  '--host',
  '--role',
  '--type',
  '--other-user'
]);

/**
 * Redact common credential forms from a command before it appears in a prompt.
 *
 * This is a best-effort filter for the usual password/token flags and
 * environment assignments. It is not a guarantee: a credential written in an
 * unrecognised form can still be part of the command text, so secrets should
 * not be put on a command line in the first place.
 */
export function redactCommand(command: string): string {
  let redacted = command;
  // Long flags, with either `=` or whitespace before the value.
  redacted = redacted.replace(
    /((?:--password|--passwd|--token|--api-key|--api_key|--apikey|--secret|--access-token|--auth-token)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`
  );
  // Environment-style assignments such as PASSWORD=..., TOKEN=..., API_KEY=...
  // including prefixed names like APP_PASSWORD=...
  redacted = redacted.replace(
    /(\b[A-Za-z0-9_]*(?:PASSWORD|PASSWD|TOKEN|API_KEY|APIKEY|SECRET|ACCESS_TOKEN|AUTH_TOKEN)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`
  );
  // MySQL short password forms: -psecret and -p secret.
  redacted = redacted.replace(/(\s-p)(?:"[^"]*"|'[^']*'|[^\s]+)/g, (_match, prefix: string) => `${prefix}${REDACTED}`);
  redacted = redacted.replace(/(\s-p\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, (_match, prefix: string) => `${prefix}${REDACTED}`);
  return redacted;
}

/**
 * A command excerpt safe to put in a prompt: one line and bounded length. Only
 * the command is kept, never a working directory or environment. Common
 * credential flags are redacted by {@link redactCommand} before this runs.
 */
export function boundedCommand(command: string, limit: number = PROMPT_COMMAND_LIMIT): string {
  const single = command.replace(/\s+/g, ' ').trim();
  if (single.length <= limit) {
    return single;
  }
  return `${single.slice(0, Math.max(0, limit - 1))}\u2026`;
}

/**
 * Classify one command. Returns `undefined` when nothing destructive is
 * recognised; a stored approval rule may then answer normally.
 *
 * `extraPatterns` are user-supplied regular expressions. A blank or invalid
 * pattern is ignored rather than disabling the built-in checks.
 */
export function classifyDestructiveCommand(
  command: string,
  extraPatterns: readonly (string | RegExp)[] = []
): DestructiveMatch | undefined {
  if (!command || command.trim().length === 0) {
    return undefined;
  }

  const segments = tokenizeShell(command);
  for (const tokens of segments) {
    const match = matchBuiltin(tokens, command, extraPatterns);
    if (match) {
      return match;
    }
    if (databaseDropInSegment(tokens)) {
      return matchFor('database-drop', command);
    }
  }

  for (const pattern of extraPatterns) {
    if (matchesPattern(command, pattern)) {
      return matchFor('custom', command);
    }
  }

  return undefined;
}

function matchFor(category: DestructiveCategory, command: string): DestructiveMatch {
  const label = LABELS[category];
  return {
    category,
    label,
    reason: reasonFor(label, command)
  };
}

function reasonFor(label: string, command: string): string {
  return `${capitalize(label)}: ${boundedCommand(redactCommand(command))}`;
}

function matchesPattern(command: string, pattern: string | RegExp): boolean {
  if (typeof pattern === 'string') {
    const source = pattern.trim();
    if (source.length === 0) {
      return false;
    }
    try {
      return new RegExp(source, 'i').test(command);
    } catch {
      return false;
    }
  }
  try {
    pattern.lastIndex = 0;
    const matched = pattern.test(command);
    pattern.lastIndex = 0;
    return matched;
  } catch {
    return false;
  }
}

function matchBuiltin(
  tokens: readonly string[],
  command: string,
  extraPatterns: readonly (string | RegExp)[]
): DestructiveMatch | undefined {
  const start = commandStart(tokens);
  if (start >= tokens.length) {
    return undefined;
  }
  const name = commandName(tokens[start]);
  const args = tokens.slice(start + 1);

  if (name === 'rm' && rmRecursiveForce(args)) {
    return matchFor('recursive-delete', command);
  }
  if ((name === 'remove-item' || name === 'ri' || name === 'del' || name === 'erase') && powershellRecursiveForce(args)) {
    return matchFor('recursive-delete', command);
  }
  if ((name === 'rmdir' || name === 'rd' || name === 'del' || name === 'erase') && cmdRecursiveQuiet(args)) {
    return matchFor('recursive-delete', command);
  }

  if (name === 'git') {
    const sub = gitSubcommand(args);
    if (sub?.name === 'push' && sub.args.some(forcePushFlag)) {
      return matchFor('force-push', command);
    }
    if (sub?.name === 'reset' && sub.args.some((arg) => arg.toLowerCase() === '--hard')) {
      return matchFor('hard-reset', command);
    }
  }

  const nested = nestedCommand(tokens, start, name);
  if (nested) {
    const inner = classifyDestructiveCommand(nested, extraPatterns);
    if (inner) {
      return {
        category: inner.category,
        label: inner.label,
        reason: reasonFor(inner.label, command)
      };
    }
  }

  if (name === 'find') {
    const execIndex = tokens.findIndex((token, index) => {
      if (index <= start) {
        return false;
      }
      const lower = token.toLowerCase();
      return lower === '-exec' || lower === '-execdir' || lower === '-ok' || lower === '-okdir';
    });
    if (execIndex >= 0) {
      return matchBuiltin(tokens.slice(execIndex + 1), command, extraPatterns);
    }
  }

  return undefined;
}

function databaseDropInSegment(tokens: readonly string[]): boolean {
  const start = commandStart(tokens);
  if (start >= tokens.length) {
    return false;
  }
  const name = commandName(tokens[start]);
  const args = tokens.slice(start + 1);
  const text = tokens.join(' ');
  const prismaExecute =
    name === 'prisma' && args[0]?.toLowerCase() === 'db' && args[1]?.toLowerCase() === 'execute';
  if (!DATABASE_CLIENTS.has(name) && !prismaExecute) {
    return false;
  }
  return /\bDROP\s+(TABLE|DATABASE)\b/i.test(text) || /\bdropDatabase\s*\(/i.test(text);
}

function commandStart(tokens: readonly string[]): number {
  let index = 0;
  for (let guard = 0; guard < 32 && index < tokens.length; guard += 1) {
    while (index < tokens.length && isAssignment(tokens[index])) {
      index += 1;
    }
    if (index >= tokens.length) {
      return index;
    }
    const name = commandName(tokens[index]);
    if (!WRAPPERS.has(name)) {
      return index;
    }
    index = skipWrapper(tokens, index, name);
  }
  return index;
}

function skipWrapper(tokens: readonly string[], index: number, name: string): number {
  const start = index + 1;
  switch (name) {
    case 'sudo':
    case 'doas':
      return skipOptions(tokens, start, SHELL_VALUE_FLAGS);
    case 'env':
      return skipOptions(tokens, start, new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']));
    case 'nice':
      return skipOptions(tokens, start, new Set(['-n', '--adjustment']));
    case 'ionice':
      return skipOptions(tokens, start, new Set(['-c', '-n', '-p', '-P', '-u']));
    case 'time':
      return skipOptions(tokens, start, new Set(['-o', '-f', '--output', '--format']));
    case 'stdbuf':
      return skipOptions(tokens, start, new Set(['-i', '-o', '-e']));
    case 'timeout': {
      let next = skipOptions(tokens, start, new Set(['-s', '-k', '--signal', '--kill-after']));
      if (next < tokens.length && !tokens[next].startsWith('-')) {
        next += 1;
      }
      return next;
    }
    case 'xargs':
      return skipOptions(
        tokens,
        start,
        new Set(['-n', '-P', '-I', '-L', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--replace', '--max-lines'])
      );
    case 'exec':
      return skipOptions(tokens, start, new Set(['-a']));
    default:
      return skipOptions(tokens, start, new Set());
  }
}

function skipOptions(tokens: readonly string[], start: number, valueFlags: ReadonlySet<string>): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      return index + 1;
    }
    if (!token.startsWith('-') || token === '-') {
      return index;
    }
    index += valueFlags.has(token) ? 2 : 1;
  }
  return index;
}

function nestedCommand(tokens: readonly string[], start: number, name: string): string | undefined {
  if (SHELLS.has(name)) {
    const flag = tokens.findIndex((token, index) => index > start && isShellCommandFlag(token));
    return flag >= 0 ? tokens.slice(flag + 1).join(' ') : undefined;
  }
  if (name === 'powershell' || name === 'pwsh') {
    const flag = tokens.findIndex((token, index) => {
      if (index <= start) {
        return false;
      }
      const lower = token.toLowerCase();
      return lower === '-command' || lower === '-c' || lower === '-encodedcommand' || lower === '-e' || lower === '-ec';
    });
    if (flag >= 0) {
      return tokens.slice(flag + 1).join(' ');
    }
    // With no -Command, PowerShell treats the first non-option token (and the
    // rest of the line) as an implicit command.
    let index = start + 1;
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const flagName = tokens[index].toLowerCase().split(':', 1)[0];
      index += POWERSHELL_VALUE_FLAGS.has(flagName) ? 2 : 1;
    }
    return index < tokens.length ? tokens.slice(index).join(' ') : undefined;
  }
  if (name === 'cmd') {
    const flag = tokens.findIndex((token, index) => {
      if (index <= start) {
        return false;
      }
      const lower = token.toLowerCase();
      return lower === '/c' || lower === '/k';
    });
    return flag >= 0 ? tokens.slice(flag + 1).join(' ') : undefined;
  }
  if (name === 'eval') {
    return tokens.slice(start + 1).join(' ');
  }
  return undefined;
}

function isShellCommandFlag(token: string): boolean {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) {
    return false;
  }
  return token.slice(1).includes('c');
}

function rmRecursiveForce(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    if (arg === '--') {
      break;
    }
    if (arg.startsWith('--')) {
      const flag = arg.split('=', 1)[0].toLowerCase();
      if (flag === '--recursive') {
        recursive = true;
      }
      if (flag === '--force') {
        force = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1);
      if (/^[a-zA-Z]+$/.test(flags)) {
        if (flags.includes('r') || flags.includes('R')) {
          recursive = true;
        }
        if (flags.includes('f')) {
          force = true;
        }
      }
    }
  }
  return recursive && force;
}

function powershellRecursiveForce(args: readonly string[]): boolean {
  let recursive = false;
  let force = false;
  for (const arg of args) {
    const flag = arg.toLowerCase().split(':', 1)[0];
    if (flag === '-recurse') {
      recursive = true;
    }
    if (flag === '-force') {
      force = true;
    }
  }
  return recursive && force;
}

function cmdRecursiveQuiet(args: readonly string[]): boolean {
  const flags = new Set<string>();
  for (const arg of args) {
    const lower = arg.toLowerCase();
    // Accept `/s /q` and the combined `/s/q` (in either order).
    if (/^\/[a-z]+(?:\/[a-z]+)*$/.test(lower)) {
      for (const flag of lower.split('/')) {
        if (flag) {
          flags.add(flag);
        }
      }
    }
  }
  return flags.has('s') && flags.has('q');
}

function gitSubcommand(args: readonly string[]): { name: string; args: readonly string[] } | undefined {
  const valueFlags = new Set([
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--exec-path',
    '--config-env',
    '--super-prefix',
    '--attr-source'
  ]);
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) {
      break;
    }
    index += valueFlags.has(token) ? 2 : 1;
  }
  if (index >= args.length) {
    return undefined;
  }
  return { name: args[index].toLowerCase(), args: args.slice(index + 1) };
}

function forcePushFlag(arg: string): boolean {
  const lower = arg.toLowerCase();
  if (
    lower === '--force' ||
    lower === '--delete' ||
    lower === '--force-with-lease' ||
    lower === '--force-if-includes' ||
    lower.startsWith('--force=') ||
    lower.startsWith('--force-with-lease=') ||
    lower.startsWith('--force-if-includes=')
  ) {
    return true;
  }
  // `+main` / `+refs/heads/main` is git's refspec form of a force push, while
  // `:branch` is its delete-refspec form.
  if ((arg.startsWith('+') || arg.startsWith(':')) && arg.length > 1) {
    return true;
  }
  return /^-[a-zA-Z]+$/.test(arg) && /[fd]/.test(lower.slice(1));
}

function commandName(token: string): string {
  const base = token.replace(/\\/g, '/').split('/').pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

/**
 * Split a shell command into simple-command segments and tokens.
 *
 * Quotes group words (so quoted SQL and quoted wrapper payloads stay one
 * token), while unquoted `;`, `&&`, `||`, `|`, newlines and command
 * substitutions start a new segment. Operator characters are not tokens, so a
 * command after a pipe or `&&` is still found.
 */
export function tokenizeShell(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let inToken = false;

  const flushToken = (): void => {
    if (inToken) {
      tokens.push(current);
      current = '';
      inToken = false;
    }
  };
  const flushSegment = (): void => {
    flushToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      tokens = [];
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      inToken = true;
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === '\\' && quote === '"') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
        inToken = true;
        continue;
      }
      current += char;
      inToken = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      flushSegment();
      index += 1;
      continue;
    }
    if (char === '`') {
      flushSegment();
      continue;
    }
    if (char === '\n' || char === '\r' || char === ';' || char === '&' || char === '|' || char === '(' || char === ')') {
      flushSegment();
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }
    current += char;
    inToken = true;
  }

  flushSegment();
  return segments;
}

/** True when a request is a command carrying any destructive risk. */
export function isDestructiveRequest(
  request: ApprovalRequest,
  extraPatterns: readonly (string | RegExp)[] = []
): DestructiveMatch | undefined {
  if (request.kind !== 'command' || !request.command) {
    return undefined;
  }
  return classifyDestructiveCommand(request.command, extraPatterns);
}
