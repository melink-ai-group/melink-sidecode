/**
 * Human labels for tool transcript rows.
 *
 * The card shows a short action phrase plus the real target (path, command,
 * pattern, or query). A lifecycle word such as "completed" is never a target:
 * that belongs on the status chip, not the detail line.
 */

const STATUS_TEXT = new Set([
  'completed',
  'complete',
  'pending',
  'running',
  'error',
  'failed',
  'inprogress',
  'in_progress',
  'in progress',
  'success',
  'cancelled',
  'canceled',
  'done',
  'passed'
]);

/** True when a string is a lifecycle word rather than something the tool acted on. */
export function isStatusText(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return STATUS_TEXT.has(value.trim().toLowerCase());
}

/** A non-empty target, or undefined when the value is blank or a status word. */
export function cleanToolTarget(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || isStatusText(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function asToolString(value: unknown): string | undefined {
  return typeof value === 'string' ? cleanToolTarget(value) : undefined;
}

/** OpenCode names this `zvec_grep_zvec_grep_search`; other hosts drop or prefix the server. */
export function isZvecSemanticSearch(tool: string): boolean {
  const id = tool.trim().toLowerCase();
  return id === 'zvec_grep_search' || id.endsWith('_zvec_grep_search');
}

/** OpenCode names this `ast_grep_search` / `ast_grep_ast_grep_search`. */
export function isAstGrepTool(tool: string): boolean {
  const id = tool.trim().toLowerCase();
  return id.includes('ast_grep') && (id.includes('search') || id.includes('replace'));
}

export function isAstGrepReplace(tool: string): boolean {
  const id = tool.trim().toLowerCase();
  return id.includes('ast_grep') && id.includes('replace');
}

function searchPhrase(input: Record<string, unknown> | undefined): string | undefined {
  const query = pick(input, ['query']);
  if (query) {
    return query;
  }
  const listed = input?.fts ?? input?.queries;
  if (Array.isArray(listed)) {
    const terms = listed.map((entry) => asToolString(entry)).filter((entry): entry is string => entry !== undefined);
    if (terms.length > 0) {
      return terms.join(', ');
    }
  }
  return pick(input, ['pattern', 'search', 'regex']);
}

function pick(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asToolString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * The path, command, pattern, or query a tool call actually used.
 * Only fields present on the payload are considered.
 */
export function targetForTool(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>
): string | undefined {
  const id = tool.trim().toLowerCase();
  if (isZvecSemanticSearch(id)) {
    return searchPhrase(input) ?? searchPhrase(metadata);
  }
  if (isAstGrepTool(id)) {
    return pick(input, ['pattern', 'rewrite']) ?? pick(metadata, ['pattern', 'rewrite']);
  }
  const file =
    pick(metadata, ['filepath', 'filePath', 'file_path', 'path']) ??
    pick(input, ['filePath', 'file_path', 'filepath', 'path', 'file', 'filename', 'directory', 'dir']);
  const pattern = pick(input, ['pattern', 'query', 'search', 'regex']);
  const glob = pick(input, ['pattern', 'glob', 'glob_pattern']);
  const command = pick(input, ['command', 'cmd', 'script']);
  const url = pick(input, ['url', 'href', 'uri']);

  switch (id) {
    case 'read':
    case 'write':
    case 'edit':
    case 'patch':
    case 'strreplace':
    case 'apply_patch':
    case 'delete':
    case 'remove':
    case 'list':
    case 'ls':
    case 'listdir':
      return file;
    case 'grep':
    case 'search':
    case 'codesearch':
    case 'rg':
      return pattern ?? file;
    case 'glob':
    case 'find':
      return glob ?? file;
    case 'bash':
    case 'shell':
    case 'command':
    case 'exec':
    case 'powershell':
      return command;
    case 'webfetch':
    case 'web_fetch':
    case 'fetch':
      return url ?? file;
    case 'websearch':
    case 'web_search':
      return pattern ?? pick(input, ['q']);
    default:
      return command ?? file ?? pattern ?? glob ?? url;
  }
}

/** Pull a target out of a JSON arguments blob (app-server tool calls). */
export function targetFromJson(tool: string, args: unknown): string | undefined {
  if (typeof args === 'string') {
    return cleanToolTarget(args);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  return targetForTool(tool, args as Record<string, unknown>);
}

function fileLabel(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return base || path;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || value.trim();
}

/** Display-only: unwrap known shell launchers without changing the executed command. */
function commandTitle(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 4; depth += 1) {
    const launcher = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(current);
    if (!launcher) {
      break;
    }
    const executable = (launcher[1] ?? launcher[2] ?? launcher[3]).replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    const args = launcher[4];
    let payload: string | undefined;
    if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable ?? '')) {
      payload = /^(?:(?:-NoLogo|-NoProfile|-NonInteractive|-Login)\s+|-(?:ExecutionPolicy|WindowStyle)\s+\S+\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(args)?.[1];
    } else if (/^(?:bash|sh|zsh|dash|ksh)(?:\.exe)?$/.test(executable ?? '')) {
      payload = /^(?:(?:--login|--noprofile|--norc|-[li]+)\s+)*-[li]*c[li]*\s+([\s\S]+)$/.exec(args)?.[1];
      // POSIX -c consumes one argument, not the rest of the command line.
      // Preserve unquoted payloads rather than mistake positional arguments for script text.
      if (payload && !payload.startsWith('"') && !payload.startsWith("'")) {
        break;
      }
    } else if (/^cmd(?:\.exe)?$/.test(executable ?? '')) {
      payload = /^(?:(?:\/d|\/s|\/q)\s+)*\/[ck]\s+([\s\S]+)$/i.exec(args)?.[1];
    }
    if (!payload) {
      break;
    }
    payload = payload.trim();
    if (payload.startsWith('"') || payload.startsWith("'")) {
      const quote = payload[0];
      if (!payload.endsWith(quote) || payload.length < 3) {
        break;
      }
      // Extra shell arguments after a quoted script are ambiguous; keep the invocation.
      const extraArguments = quote === "'" ? /'\s+\S/ : /(?<![\\`])"\s+\S/;
      if (extraArguments.test(payload.slice(1, -1))) {
        break;
      }
      payload = payload.slice(1, -1).trim();
    }
    if (!payload) {
      break;
    }
    current = payload;
  }
  return firstLine(current);
}

function humanizeTool(tool: string): string {
  const words = tool.replace(/[._:-]+/g, ' ').trim();
  if (!words) {
    return 'Command';
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Short action phrase. Omits the target entirely when none was reported. */
export function friendlyToolTitle(tool: string, target?: string): string {
  const id = tool.trim().toLowerCase();
  const name = cleanToolTarget(target);
  if (isZvecSemanticSearch(id)) {
    return name ? `Searching for ${name}` : 'Searching';
  }
  if (isAstGrepTool(id)) {
    if (isAstGrepReplace(id)) {
      return name ? `Rewriting ${name}` : 'Rewriting';
    }
    return name ? `Searching for ${name}` : 'Searching';
  }
  switch (id) {
    case 'read':
      return name ? `Reading ${fileLabel(name)}` : 'Reading';
    case 'grep':
    case 'search':
    case 'codesearch':
    case 'rg':
      return name ? `Searching for ${name}` : 'Searching';
    case 'glob':
    case 'find':
      return name ? `Finding files ${name}` : 'Finding files';
    case 'bash':
    case 'shell':
    case 'command':
    case 'exec':
    case 'powershell':
      return name ? `Running ${commandTitle(name)}` : 'Running command';
    case 'edit':
    case 'patch':
    case 'strreplace':
    case 'apply_patch':
      return name ? `Editing ${fileLabel(name)}` : 'Editing';
    case 'write':
      return name ? `Writing ${fileLabel(name)}` : 'Writing';
    case 'list':
    case 'ls':
    case 'listdir':
      return name ? `Listing ${fileLabel(name)}` : 'Listing files';
    case 'delete':
    case 'remove':
      return name ? `Deleting ${fileLabel(name)}` : 'Deleting';
    case 'webfetch':
    case 'web_fetch':
    case 'fetch':
      return name ? `Fetching ${name}` : 'Fetching';
    case 'websearch':
    case 'web_search':
      return name ? `Searching the web for ${name}` : 'Searching the web';
    default: {
      const verb = humanizeTool(tool);
      return name ? `${verb} ${name}` : verb;
    }
  }
}

/**
 * A bare tool id (`glob`, `read`, `grep`), not a phrase or a file name.
 * Used so a replayed card can be relabeled without inventing a path.
 */
export function isRawToolName(title: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(title.trim());
}

export interface ToolCardCopy {
  title: string;
  /** Real command, path, pattern, or query. Absent when the item has no target. */
  detail?: string;
}

/**
 * Title and detail for a collapsed tool row.
 * `command` is the target. `detail` is only a fallback when it is a short
 * target rather than tool output or a status word.
 */
export function toolCardPresentation(item: {
  title?: string;
  command?: string;
  detail?: string;
}): ToolCardCopy {
  const command = cleanToolTarget(item.command);
  const detail = cleanToolTarget(item.detail);
  const fromDetail = detail && !detail.includes('\n') && detail.length <= 200 ? detail : undefined;
  const target = command ?? fromDetail;
  const raw = item.title?.trim();
  if (target && raw === `Running ${firstLine(target)}`) {
    return { title: friendlyToolTitle('command', target), detail: target };
  }
  if (!raw || raw === 'Command' || isRawToolName(raw)) {
    const tool = !raw || raw === 'Command' ? 'command' : raw;
    return { title: friendlyToolTitle(tool, target), detail: target };
  }
  return { title: raw, detail: target };
}
