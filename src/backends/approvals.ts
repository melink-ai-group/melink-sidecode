import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  ApprovalRule
} from './types';
import { relativeWithin } from '../changes/journal.ts';

/**
 * Pure approval-rule logic: describing a request, building the rule a decision
 * would store, matching an incoming request against a rule, and scoping session
 * rules to a thread. Kept free of `vscode` and of the transport so the scoping
 * rules are unit-testable and the same shape is used by `always` and `session`.
 *
 * ## T66 invariants
 *
 * A stored rule must never allow more than the user actually approved, so a
 * rule is matched against a *command family* rather than a loose prefix:
 *
 * - **Family, not program.** A rule stores the program plus its leading
 *   non-flag tokens, so a rule for `git status` cannot approve `git commit` or
 *   `git push`, and a rule for `npm test` cannot approve `npm publish`.
 * - **Read-only git never covers a write.** Git subcommands are classified
 *   conservatively; anything uncertain is a write and needs re-approval. A rule
 *   created for a write subcommand may still match that same write family.
 * - **Unclassifiable commands are exact.** Shell chaining, a wrapper script, an
 *   interpreter, or a flag placed before the subcommand cannot be reduced to a
 *   safe family, so the rule matches that exact token list and nothing else.
 * - **Path boundaries are real.** A file rule matches a path only at a
 *   directory boundary, so a rule for `/ws/src` never covers `/ws/src-evil`.
 * - **Legacy rules never match.** A command rule persisted before this change
 *   has no family; it is dropped on load instead of silently keeping its old
 *   broad meaning.
 */

/** Human-readable label for what a request concerns, used on rules and cards. */
export function describeApproval(request: ApprovalRequest): string {
  switch (request.kind) {
    case 'command': {
      const command = request.displayCommand ?? request.command;
      if (command) {
        return command;
      }
      return 'a command';
    }
    case 'file-change': {
      const paths = request.paths ?? [];
      if (paths.length === 1) {
        return `writes under ${paths[0]}`;
      }
      if (paths.length > 1) {
        return `writes under ${paths.length} paths`;
      }
      return 'file changes';
    }
    case 'permissions': {
      return request.network ? `network access to ${request.network}` : 'extra permissions';
    }
    default:
      return 'an action';
  }
}

/**
 * The scope a decision persists as. `allow-once` and `reject` persist nothing;
 * `always` becomes a global rule; `session` becomes a thread-scoped rule. This
 * is the single mapping from the user's decision to storage, so a decision can
 * never silently widen further than it claims.
 */
export function ruleScopeFor(decision: ApprovalDecision): 'none' | 'global' | 'session' {
  switch (decision) {
    case 'allow-always':
      return 'global';
    case 'allow-session':
      return 'session';
    case 'allow-once':
    case 'reject':
    default:
      return 'none';
  }
}

/**
 * Build the rule a decision stores. The rule records enough structure (kind,
 * command family, file roots, origin, and the native proposed amendment) to be
 * listed, matched and revoked later, and `scope` is the exact sentence shown
 * when listing it.
 */
export function ruleFor(
  request: ApprovalRequest,
  backendId: string,
  now: number = Date.now()
): ApprovalRule {
  const rule: ApprovalRule = {
    id: `rule_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    backendId,
    kind: request.kind,
    scope: describeApproval(request),
    origin: request.origin,
    createdAt: now
  };
  if (request.execPolicyAmendment && request.execPolicyAmendment.length > 0) {
    // The native amendment is kept verbatim: it is the shape the CLI itself
    // proposed, and it is what an `always` decision answers with.
    rule.execPolicyAmendment = [...request.execPolicyAmendment];
  }
  if (request.kind === 'command') {
    // The family comes only from the command the user actually saw. The native
    // amendment is never used to derive it: it can be broader than the shown
    // command, and it is kept verbatim above for the native decision. When the
    // command cannot be classified safely the rule stores no family at all, so
    // it never matches anything (inert).
    const key = commandMatchKey(request.command);
    if (key) {
      rule.commandFamily = [...key.family];
      rule.commandPrefix = [...key.family];
      rule.commandExact = key.exact;
      rule.gitWrite = key.gitWrite;
    }
  }
  if (request.kind === 'file-change') {
    if (request.paths && request.paths.length > 0) {
      rule.paths = [...request.paths];
    } else if (request.grantRoot) {
      rule.paths = [request.grantRoot];
    }
  }
  if (request.kind === 'permissions' && request.network) {
    rule.host = request.network;
  }
  return rule;
}

/**
 * The first token of a command. Kept for the legacy exec-policy shape; rule
 * matching uses the command *family* instead of a first-token prefix.
 */
export function commandPrefix(command: string): string[] {
  const token = command.trim().split(/\s+/, 1)[0];
  return token ? [token] : [];
}

/**
 * What a command is, in the shape a rule is matched against.
 *
 * - `tokens` — every token of the command, in order.
 * - `family` — the program plus its leading non-flag tokens; the unit a rule
 *   is scoped to.
 * - `exact` — true when the command cannot be reduced to a safe family, so it
 *   may only match that exact token list.
 * - `git` — true when the program is git.
 * - `gitWrite` — true when the git subcommand writes. A read-only rule never
 *   matches a write.
 */
export interface CommandMatchKey {
  tokens: string[];
  family: string[];
  exact: boolean;
  git: boolean;
  gitWrite: boolean;
}

/**
 * Classify a command into the family a rule is matched by.
 *
 * Returns `undefined` when the command cannot be classified safely at all: an
 * empty command, a composed shell command, an environment assignment, or an
 * unbalanced quote. Such a command is never auto-approved.
 */
export function commandMatchKey(command: string | undefined): CommandMatchKey | undefined {
  if (!command) {
    return undefined;
  }
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!isSimpleCommand(trimmed)) {
    return undefined;
  }
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return undefined;
  }
  if (ENV_ASSIGNMENT.test(tokens[0])) {
    // `FOO=bar git status` can smuggle a different program or a different
    // environment, so it is never auto-approved.
    return undefined;
  }
  return matchKeyFromTokens(tokens);
}

/**
 * Programs that run another command, so their own argument list is not the
 * command being approved. A rule for one of these is exact: it only ever
 * matches the very same token list.
 */
const WRAPPER_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'timeout',
  'nohup',
  'watch',
  'sudo',
  'doas',
  'su',
  'runuser',
  'parallel',
  'find',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'lua',
  'rscript',
  'osascript',
  'wsl'
]);

/** A leading `NAME=value` is an environment assignment, not a program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Git subcommands that only read the repository. */
const GIT_READ_ONLY = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'shortlog',
  'show-ref',
  'for-each-ref',
  'rev-list',
  'name-rev',
  'merge-base',
  'diff-tree',
  'whatchanged',
  'count-objects',
  'fsck',
  'help',
  'version'
]);

/**
 * Classify an already tokenized command. The family is the program plus its
 * leading non-flag tokens; a flag before the subcommand (`git --no-pager
 * status`) makes the command unclassifiable, so it becomes an exact rule.
 *
 * Program detection is case-insensitive (`GIT`, `Git`, `git.exe` are all git),
 * while the family keeps the token casing as typed. For non-git commands a
 * non-flag token after the first flag (`npm run --silent build`) hides which
 * script or target runs, so that command is exact as well. Git is the
 * exception: its family is program plus subcommand, and later arguments only
 * drive read/write classification.
 */
export function matchKeyFromTokens(tokens: string[]): CommandMatchKey | undefined {
  if (tokens.length === 0) {
    return undefined;
  }
  const originalProgram = tokens[0];
  const rawProgram = programName(originalProgram);
  const program = canonicalProgram(rawProgram);
  const loweredProgram = program.toLowerCase();
  if (WRAPPER_PROGRAMS.has(loweredProgram)) {
    // A wrapper decides what actually runs, so only the exact same invocation
    // may be auto-approved.
    return { tokens: [...tokens], family: [...tokens], exact: true, git: false, gitWrite: false };
  }
  // A non-git family keeps the program token as typed, including its full path,
  // so `/opt/tool run` never covers `/tmp/tool run`. The canonical basename is
  // only for detecting git and wrappers. Git keeps its canonical name, so every
  // spelling of `git` shares the same guarded family.
  const family = [isGitProgram(program) ? program : originalProgram];
  let end = 1;
  for (; end < tokens.length; end += 1) {
    const token = tokens[end];
    if (token.startsWith('-')) {
      break;
    }
    family.push(token);
  }
  if (end === 1 && tokens.length > 1) {
    // A flag before the subcommand hides which subcommand runs, so the whole
    // invocation has to match exactly.
    return {
      tokens: [...tokens],
      family: [...tokens],
      exact: true,
      git: isGitProgram(program),
      gitWrite: isGitProgram(program)
    };
  }
  if (isGitProgram(program)) {
    if (family.length < 2) {
      // Bare `git` does nothing on its own, so it is never a read-only family.
      return { tokens: [...tokens], family: [...tokens], exact: true, git: true, gitWrite: true };
    }
    return {
      tokens: [...tokens],
      family,
      exact: false,
      git: true,
      // Every argument after the subcommand is inspected, not only the ones
      // past the family, so a write hiding in a leading positional
      // (`git config user.name x`) is still seen as a write. The read/write
      // marker therefore stays consistent for one family.
      gitWrite: gitSubcommandWrites(family[1], tokens.slice(2))
    };
  }
  if (tokens.length === 1) {
    return { tokens: [...tokens], family: [originalProgram], exact: false, git: false, gitWrite: false };
  }
  if (tokens.slice(end).some((token) => !token.startsWith('-'))) {
    // A non-flag token after the first flag is not part of the leading family
    // (`npm run --silent build` vs `npm run --silent publish`), so the whole
    // invocation has to match exactly.
    return { tokens: [...tokens], family: [...tokens], exact: true, git: false, gitWrite: false };
  }
  return { tokens: [...tokens], family, exact: false, git: false, gitWrite: false };
}

/** The program name of a command, without its directory. */
function programName(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
}

/**
 * The program in the spelling the guards use: a Windows `.exe`/`.cmd`/`.bat`
 * suffix is dropped, so `git.exe` is guarded exactly like `git`. Casing is
 * kept so the family records the program as typed; comparisons lowercase it.
 */
function canonicalProgram(program: string): string {
  return program.replace(/\.(exe|cmd|bat)$/i, '');
}

/** Git under any casing or Windows spelling is still git. */
function isGitProgram(program: string): boolean {
  return program.toLowerCase() === 'git';
}

/**
 * Whether a git subcommand writes. Read-only subcommands are listed
 * explicitly; the ambiguous ones (`branch`, `tag`, `remote`, `stash`, …) are
 * read-only only for clearly read-only arguments; everything else is a write,
 * so an uncertain request is re-approved instead of silently allowed.
 */
export function gitSubcommandWrites(subcommand: string, args: string[]): boolean {
  // The program guard is case-insensitive, so classify the subcommand the same
  // way even though git itself names subcommands in lowercase.
  const normalized = subcommand.toLowerCase();
  if (GIT_READ_ONLY.has(normalized)) {
    // `git diff --output=file` / `git log -o file` writes a file, so a
    // read-only subcommand carrying an output flag is not a read.
    return (
      args.some((arg) => arg === '--output' || arg.startsWith('--output=')) ||
      hasShortFlag(args, ['o'])
    );
  }
  const { positionals, flags } = splitGitArgs(args);
  switch (normalized) {
    case 'branch':
      if (positionals.length > 0) {
        return true;
      }
      return (
        hasLongFlag(flags, ['--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream', '--edit-description', '--force']) ||
        hasShortFlag(flags, ['d', 'D', 'm', 'M', 'c', 'C', 'u', 'f'])
      );
    case 'tag':
      if (positionals.length > 0) {
        return true;
      }
      return (
        hasLongFlag(flags, ['--delete', '--annotate', '--sign', '--local-user', '--force', '--message', '--file', '--create-reflog']) ||
        hasShortFlag(flags, ['d', 'a', 's', 'u', 'f', 'm', 'F'])
      );
    case 'remote':
      // `git remote` with no subcommand lists the remotes; any subcommand
      // (`add`, `set-url`, `remove`, …) changes them.
      return positionals.length > 0;
    case 'stash':
      if (hasLongFlag(flags, ['--include-untracked', '--all', '--patch', '--keep-index']) ||
        hasShortFlag(flags, ['u', 'a', 'p', 'k'])) {
        return true;
      }
      if (positionals.length === 0) {
        // Bare `git stash` pops the stash and restores the working tree, so it
        // writes even though it names no subcommand.
        return true;
      }
      return positionals[0] !== 'list' && positionals[0] !== 'show';
    case 'config':
      if (positionals.length >= 2) {
        return true;
      }
      return (
        hasLongFlag(flags, ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--edit']) ||
        hasShortFlag(flags, ['e'])
      );
    case 'notes':
      if (positionals.length === 0) {
        return false;
      }
      return positionals[0] !== 'list' && positionals[0] !== 'show';
    case 'reflog':
      if (positionals.length === 0) {
        return false;
      }
      return positionals[0] !== 'show';
    case 'worktree':
      if (positionals.length === 0) {
        return false;
      }
      return positionals[0] !== 'list';
    case 'submodule':
      if (positionals.length === 0) {
        return false;
      }
      return positionals[0] !== 'status' && positionals[0] !== 'summary';
    case 'bisect':
      if (positionals.length === 0) {
        return false;
      }
      return positionals[0] !== 'log';
    default:
      // Unknown or write subcommand (`commit`, `push`, `checkout`, `switch`,
      // `restore`, `reset`, …): a write.
      return true;
  }
}

/** Split git arguments into positionals and flags, honouring a `--` marker. */
function splitGitArgs(args: string[]): { positionals: string[]; flags: string[] } {
  const positionals: string[] = [];
  const flags: string[] = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === '--') {
      literal = true;
      flags.push(arg);
      continue;
    }
    if (!literal && arg.startsWith('-') && arg.length > 1) {
      flags.push(arg);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

/** Whether any flag is one of the given long flags (`--flag` or `--flag=value`). */
function hasLongFlag(flags: string[], names: string[]): boolean {
  return flags.some((flag) => {
    const name = flag.includes('=') ? flag.slice(0, flag.indexOf('=')) : flag;
    return names.includes(name);
  });
}

/** Whether any short flag group contains one of the given letters (`-D`, `-dm`). */
function hasShortFlag(flags: string[], letters: string[]): boolean {
  return flags.some((flag) => {
    if (!flag.startsWith('-') || flag.startsWith('--') || flag.length < 2 || flag.includes('=')) {
      return false;
    }
    return [...flag.slice(1)].some((letter) => letters.includes(letter));
  });
}

/**
 * Whether a command is a single simple command. Shell composition (`;`, `|`,
 * `&&`, redirects, command substitution, backticks, newlines) is rejected, as
 * is an unbalanced quote, so a composed command is never auto-approved.
 */
function isSimpleCommand(command: string): boolean {
  let quote: '"' | "'" | undefined;
  let atWordStart = true;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '\\') {
        // A backslash escapes the next character (`\"`, `\$`, `` \` ``), so
        // it is not substitution or the closing quote.
        index += 1;
        continue;
      }
      if (char === '"') {
        quote = undefined;
        continue;
      }
      if (char === '`') {
        // Command substitution is active inside double quotes, so a backtick
        // there composes another command just like an unquoted one.
        return false;
      }
      if (char === '$' && (command[index + 1] === '(' || command[index + 1] === '{')) {
        // `$(...)` and `${...}` are expanded inside double quotes too.
        return false;
      }
      continue;
    }
    if (char === '\\') {
      index += 1;
      atWordStart = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      atWordStart = false;
      continue;
    }
    if (char === '$' && (command[index + 1] === '(' || command[index + 1] === '{')) {
      return false;
    }
    if (char === '#' && atWordStart) {
      // A `#` at the start of a word starts a comment, which hides the rest.
      return false;
    }
    if (
      char === ';' ||
      char === '|' ||
      char === '&' ||
      char === '<' ||
      char === '>' ||
      char === '`' ||
      char === '(' ||
      char === ')' ||
      char === '\n' ||
      char === '\r'
    ) {
      return false;
    }
    atWordStart = char === ' ' || char === '\t';
  }
  return quote === undefined;
}

/**
 * Whether a stored rule already covers an incoming request. A rule only matches
 * a request of the same kind, and each kind matches on its own recorded scope,
 * so a command rule can never be treated as an allow for a file write.
 */
export function ruleMatchesRequest(rule: ApprovalRule, request: ApprovalRequest): boolean {
  if (rule.kind !== request.kind) {
    return false;
  }
  switch (rule.kind) {
    case 'command': {
      const family = rule.commandFamily ?? [];
      if (family.length === 0) {
        // A legacy command rule has no family, so it never matches: it must
        // not keep its old, broader meaning.
        return false;
      }
      const key = commandMatchKey(request.command);
      if (!key) {
        return false;
      }
      if (rule.commandExact) {
        return arraysEqual(family, key.tokens);
      }
      if (key.exact) {
        // The request cannot be reduced to a family, so a family rule cannot
        // claim it.
        return false;
      }
      return arraysEqual(family, key.family) && (rule.gitWrite ?? false) === key.gitWrite;
    }
    case 'file-change': {
      const roots = rule.paths ?? [];
      if (roots.length === 0) {
        return false;
      }
      const paths = request.paths ?? [];
      if (paths.length === 0) {
        // A grant-root request with no explicit paths is covered only when the
        // rule is for that exact root.
        const grantRoot = request.grantRoot;
        return grantRoot !== undefined && roots.some((root) => withinRoot(grantRoot, root));
      }
      return paths.every((path) => roots.some((root) => withinRoot(path, root)));
    }
    case 'permissions': {
      if (!request.network) {
        return false;
      }
      return rule.host === request.network;
    }
    default:
      return false;
  }
}

/**
 * Whether a path is a root or a descendant of it, at a directory boundary.
 * `/ws/src` therefore covers `/ws/src/index.ts` but never `/ws/src-evil/x.ts`.
 */
function withinRoot(candidate: string, root: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return relativeWithin(normalize(candidate), normalize(root)) !== undefined;
}

/**
 * Drop persisted rules that predate the command family, so a legacy command
 * rule (one that only stored the executable name) cannot keep allowing every
 * subcommand of that program. File and permissions rules are kept.
 */
export function migrateApprovalRules(rules: readonly ApprovalRule[]): ApprovalRule[] {
  return rules.filter((rule) => {
    if (rule.kind !== 'command') {
      return true;
    }
    return (rule.commandFamily ?? []).length > 0;
  });
}

/**
 * The first stored rule that covers a request, searching session rules (this
 * thread) before global ones. A hit means the request can proceed without
 * asking; a miss means the user must decide. Nothing here decides on its own.
 */
export function findMatchingRule(
  request: ApprovalRequest,
  sessionRules: readonly ApprovalRule[],
  globalRules: readonly ApprovalRule[]
): ApprovalRule | undefined {
  return (
    sessionRules.find((rule) => ruleMatchesRequest(rule, request)) ??
    globalRules.find((rule) => ruleMatchesRequest(rule, request))
  );
}

/** Key for one thread's session scope, shared by the store and the adapter. */
export function sessionKey(backendId: string, threadId: string): string {
  return `${backendId}:${threadId}`;
}

/** Split a command into tokens for prefix matching, preserving quoting groups. */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/** Whether two token lists are the same, element for element. */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** The kinds a backend's approval channel is expected to surface. */
export const APPROVAL_REQUEST_KINDS: readonly ApprovalRequestKind[] = ['command', 'file-change', 'permissions'];
