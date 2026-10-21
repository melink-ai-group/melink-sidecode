/**
 * Optional, bounded symbol/import map.
 *
 * The snapshot already decides which workspace files are safe to read. This
 * module turns that accepted list into a small per-turn index:
 *
 * - **Bounded by construction.** File count, bytes, wall-clock time, symbols and
 *   the rendered characters all have caps. Every cap stops the build
 *   deterministically and marks the result `limited`.
 * - **Host-free.** It takes a `readFile` seam and an injected clock; it imports
 *   no `vscode` and no filesystem API, so `npm test` can drive it.
 * - **Failure is explicit.** A missing seam, a failed read or a build over budget
 *   produces a one-line marker. It never throws and never silently claims data.
 * - **Static parsing only.** Definitions and imports come from regular
 *   expressions. This is a map, not a compiler: a dynamic import or a generated
 *   symbol can be absent.
 */

export type RepoMapStatus = 'ok' | 'limited' | 'disabled' | 'unavailable' | 'failed';

/** Every bound the map honours. Settings expose the file, byte, time and char caps. */
export interface RepoMapCaps {
  maxFiles: number;
  maxBytes: number;
  maxBuildMs: number;
  maxSymbols: number;
  maxResults: number;
  maxChars: number;
}

/** The internal caps the settings do not expose, with documented defaults. */
export const DEFAULT_REPO_MAP_CAPS: RepoMapCaps = {
  maxFiles: 200,
  maxBytes: 131_072,
  maxBuildMs: 750,
  maxSymbols: 500,
  maxResults: 12,
  maxChars: 1_200
};

/** One accepted file's static view. */
export interface RepoMapEntry {
  /** Workspace-relative path, POSIX separators. */
  path: string;
  /** Definition names, deduplicated and in source order. */
  symbols: string[];
  /** Import/module specifiers, deduplicated and in source order. */
  imports: string[];
}

export interface RepoMapIndex {
  status: RepoMapStatus;
  /** A one-line explanation and bounds, or `''` for a complete `ok` map. */
  marker: string;
  entries: RepoMapEntry[];
  filesScanned: number;
  bytesRead: number;
  symbolCount: number;
  buildMs: number;
}

/** The rendered per-turn text plus the index it came from. */
export interface RepoMapResult {
  text: string;
  index: RepoMapIndex;
}

export const REPO_MAP_DISABLED = 'Repo map: disabled (melink.context.repoMap is off).';
export const REPO_MAP_UNAVAILABLE = 'Repo map: unavailable (no workspace snapshot or file reads).';
export const REPO_MAP_FAILED = 'Repo map: failed (one or more files could not be read).';
export const REPO_MAP_EMPTY = 'Repo map: no matching files for this request.';
export const REPO_MAP_NO_SOURCE = 'Repo map: no source files found.';

/** A per-read timeout so a slow or never-resolving seam cannot hold a turn. */
const PER_READ_TIMEOUT_MS = 150;
/** Per-file ceilings before the global symbol cap applies. */
const PER_FILE_SYMBOLS = 40;
const PER_FILE_IMPORTS = 40;

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs',
  '.rb', '.php', '.swift', '.dart', '.lua', '.pl', '.r', '.ex', '.exs',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.vue', '.svelte', '.astro'
]);

const SKIP_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum'
]);

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'where', 'when',
  'which', 'how', 'why', 'for', 'are', 'can', 'you', 'our', 'not', 'but', 'all',
  'use', 'using', 'into', 'about', 'does', 'did', 'fix', 'add', 'make', 'get',
  'set', 'please', 'this', 'its', 'was', 'were', 'will', 'would', 'should'
]);

const DEFINITION_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\binterface\s+([A-Za-z_$][\w$]*)/g,
  /\btype\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\benum\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:def|fn)\s+([A-Za-z_][\w]*)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/g,
  /\b(?:public|private|protected)\s+(?:static\s+)?(?:async\s+)?(?:function\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(/g
];

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s+([\w.]+)\s+import\b/g,
  /^\s*import\s+([\w.]+)\s*(?:#.*)?$/gm,
  /#include\s*[<"]([^>"]+)[>"]/g,
  /\buse\s+([\w:]+)/g
];

export interface BuildRepoMapOptions {
  /** Absolute workspace root the relative paths are resolved against. */
  root: string;
  /** Paths the snapshot accepted. Anything unsafe was filtered before this point. */
  files: readonly string[];
  /** The existing host read seam; absent makes the map `unavailable`. */
  readFile?: (path: string) => Promise<string | undefined>;
  caps?: Partial<RepoMapCaps>;
  /** Injected clock, so a time cap is deterministic in tests. */
  now?: () => number;
}

/**
 * Build one bounded index. Never throws: a missing seam, a failed read or an
 * exhausted cap becomes a status plus a marker.
 */
export async function buildRepoMap(options: BuildRepoMapOptions): Promise<RepoMapIndex> {
  const started = options.now ? options.now() : Date.now();
  if (!options.readFile) {
    return indexResult('unavailable', REPO_MAP_UNAVAILABLE, [], 0, 0, 0, 0);
  }
  const caps = mergeCaps(options.caps);
  const files = [...new Set(options.files.map(normalize))].filter(isSourcePath).sort();
  const entries: RepoMapEntry[] = [];
  let filesScanned = 0;
  let bytesRead = 0;
  let symbolCount = 0;
  let status: RepoMapStatus = 'ok';
  let hadError = false;
  /** True when a per-file limit or the global symbol cap actually dropped data. */
  let dropped = false;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const path = files[fileIndex];
    const now = options.now ? options.now() : Date.now();
    const elapsed = now - started;
    if (filesScanned >= caps.maxFiles) {
      status = 'limited';
      break;
    }
    if (elapsed >= caps.maxBuildMs || bytesRead >= caps.maxBytes) {
      status = 'limited';
      break;
    }

    const remaining = Math.max(1, caps.maxBuildMs - elapsed);
    let text: string | undefined | typeof TIMEOUT;
    try {
      text = await readWithTimeout(
        options.readFile,
        joinPath(options.root, path),
        Math.min(remaining, PER_READ_TIMEOUT_MS)
      );
    } catch {
      hadError = true;
      filesScanned += 1;
      continue;
    }
    if (text === TIMEOUT) {
      // A never-resolving or slow read is a bounded miss, not a crash.
      status = 'limited';
      break;
    }
    filesScanned += 1;
    if (text === undefined) {
      continue;
    }

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytesRead + bytes > caps.maxBytes) {
      status = 'limited';
      break;
    }
    bytesRead += bytes;

    const symbols = extractSymbols(text);
    const imports = extractImports(text);
    const perFileSymbols = symbols.slice(0, PER_FILE_SYMBOLS);
    if (perFileSymbols.length < symbols.length) {
      // A single large file is truncated, but it must not stop later files.
      dropped = true;
    }
    const room = Math.max(0, caps.maxSymbols - symbolCount);
    const keptSymbols = perFileSymbols.slice(0, room);
    if (keptSymbols.length < perFileSymbols.length) {
      dropped = true;
    }
    const keptImports = imports.slice(0, PER_FILE_IMPORTS);
    if (keptImports.length < imports.length) {
      dropped = true;
    }
    if (keptSymbols.length > 0 || keptImports.length > 0) {
      entries.push({ path, symbols: keptSymbols, imports: keptImports });
    }
    symbolCount += keptSymbols.length;
    if (symbolCount >= caps.maxSymbols && fileIndex < files.length - 1) {
      // The global symbol budget is exhausted while files remain unindexed.
      status = 'limited';
      break;
    }
  }

  if (hadError) {
    status = 'failed';
  } else if (dropped && status === 'ok') {
    status = 'limited';
  }
  const buildMs = Math.max(0, (options.now ? options.now() : Date.now()) - started);
  return indexResult(status, markerFor(status, caps), entries, filesScanned, bytesRead, symbolCount, buildMs);
}

/**
 * Rank the index against the user's request and the files they have dirty.
 * Definitions win, then importers of a file that defines a requested name, then
 * path/import matches. A no-match request is an explicit empty marker.
 */
export function queryRepoMap(
  index: RepoMapIndex,
  request: string,
  recentEdits: readonly string[] = [],
  caps: Partial<RepoMapCaps> = {}
): RepoMapResult {
  if (index.status !== 'ok' && index.status !== 'limited') {
    return { text: index.marker || markerFor(index.status, mergeCaps(caps)), index };
  }
  const merged = mergeCaps(caps);
  const tokens = tokenize(request);
  const edits = new Set(recentEdits.map(normalize));
  const definitions = new Map<string, string[]>();
  for (const entry of index.entries) {
    for (const symbol of entry.symbols) {
      for (const token of tokenize(symbol)) {
        const paths = definitions.get(token) ?? [];
        if (!paths.includes(entry.path)) {
          paths.push(entry.path);
        }
        definitions.set(token, paths);
      }
    }
  }

  const scored: { entry: RepoMapEntry; score: number }[] = [];
  for (const entry of index.entries) {
    let score = isDirty(entry.path, edits) ? 10 : 0;
    const pathText = normalize(entry.path);
    const pathTokens = new Set(tokenize(pathText));
    const basename = pathText.slice(pathText.lastIndexOf('/') + 1);
    for (const token of tokens) {
      if (pathTokens.has(token)) {
        score += basename.toLowerCase().includes(token) ? 5 : 2;
      }
      if (entry.symbols.some((symbol) => symbol.toLowerCase() === token)) {
        score += 5;
      } else if (entry.symbols.some((symbol) => tokenize(symbol).includes(token))) {
        score += 3;
      }
      if (entry.imports.some((specifier) => tokenize(specifier).includes(token))) {
        score += 1;
      }
      const definedIn = definitions.get(token) ?? [];
      if (
        definedIn.some((path) => path !== entry.path) &&
        definedIn.some((path) =>
          entry.imports.some((specifier) => importMatchesPath(specifier, basename, path))
        )
      ) {
        score += 2;
      }
    }
    if (tokens.length === 0 && !isDirty(entry.path, edits)) {
      continue;
    }
    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  const top = scored.slice(0, Math.max(0, merged.maxResults));
  if (top.length === 0) {
    // A limited index keeps its status marker even when the query matched
    // nothing; the empty marker must not hide that the map was partial.
    return { text: renderRepoMap(index, [], merged), index };
  }
  return { text: renderRepoMap(index, top.map((item) => entryLine(item.entry)), merged), index };
}

/**
 * Render the bounded text. A non-ok status contributes its one-line marker; a
 * limited map keeps that marker above whatever lines still fit.
 */
export function renderRepoMap(
  index: RepoMapIndex,
  lines: readonly string[] = [],
  caps: Partial<RepoMapCaps> = {}
): string {
  if (index.status !== 'ok' && index.status !== 'limited') {
    return bound(index.marker || markerFor(index.status, mergeCaps(caps)), mergeCaps(caps));
  }
  const body = lines.filter((line) => line.trim().length > 0).join('\n');
  const marker = index.status === 'limited' ? index.marker || markerFor('limited', mergeCaps(caps)) : '';
  if (!body) {
    const empty = index.entries.length === 0 ? REPO_MAP_NO_SOURCE : REPO_MAP_EMPTY;
    return bound([marker, empty].filter(Boolean).join('\n'), mergeCaps(caps));
  }
  return bound([marker, body].filter(Boolean).join('\n'), mergeCaps(caps));
}

/** Static definitions, deduplicated in source order. */
export function extractSymbols(text: string): string[] {
  return collect(text, DEFINITION_PATTERNS);
}

/** Static import specifiers, deduplicated in source order. */
export function extractImports(text: string): string[] {
  return collect(text, IMPORT_PATTERNS);
}

/** Whether an accepted path is source the map is willing to parse. */
export function isSourcePath(path: string): boolean {
  const normalized = normalize(path);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (!name || name.includes('.min.') || SKIP_BASENAMES.has(name)) {
    return false;
  }
  const dot = name.lastIndexOf('.');
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot));
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

const TIMEOUT = Symbol('repo-map-read-timeout');
type Timeout = typeof TIMEOUT;

function indexResult(
  status: RepoMapStatus,
  marker: string,
  entries: RepoMapEntry[],
  filesScanned: number,
  bytesRead: number,
  symbolCount: number,
  buildMs: number
): RepoMapIndex {
  return { status, marker, entries, filesScanned, bytesRead, symbolCount, buildMs };
}

function markerFor(status: RepoMapStatus, caps: RepoMapCaps): string {
  switch (status) {
    case 'disabled':
      return REPO_MAP_DISABLED;
    case 'unavailable':
      return REPO_MAP_UNAVAILABLE;
    case 'failed':
      return REPO_MAP_FAILED;
    case 'limited':
      return `Repo map: limited (caps files=${caps.maxFiles}, bytes=${caps.maxBytes}, ms=${caps.maxBuildMs}, symbols=${caps.maxSymbols}).`;
    case 'ok':
      return '';
  }
}

function mergeCaps(caps: Partial<RepoMapCaps> = {}): RepoMapCaps {
  return {
    maxFiles: positive(caps.maxFiles, DEFAULT_REPO_MAP_CAPS.maxFiles),
    maxBytes: positive(caps.maxBytes, DEFAULT_REPO_MAP_CAPS.maxBytes),
    maxBuildMs: positive(caps.maxBuildMs, DEFAULT_REPO_MAP_CAPS.maxBuildMs),
    maxSymbols: positive(caps.maxSymbols, DEFAULT_REPO_MAP_CAPS.maxSymbols),
    maxResults: positive(caps.maxResults, DEFAULT_REPO_MAP_CAPS.maxResults),
    maxChars: positive(caps.maxChars, DEFAULT_REPO_MAP_CAPS.maxChars)
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function joinPath(root: string, relative: string): string {
  const base = root.replace(/[\\/]+$/, '');
  return `${base}/${normalize(relative)}`;
}

function readWithTimeout(
  read: (path: string) => Promise<string | undefined>,
  path: string,
  timeoutMs: number
): Promise<string | undefined | Timeout> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // The timer is intentionally not unref'ed: during a never-resolving read it
    // is the only handle that lets the timeout settle the turn.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(TIMEOUT);
      }
    }, timeoutMs);
    read(path).then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      }
    );
  });
}

function collect(text: string, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value && !found.includes(value)) {
        found.push(value);
      }
    }
  }
  return found;
}

function tokenize(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_$]+/)
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
  return [...new Set(tokens)];
}

function isDirty(path: string, edits: Set<string>): boolean {
  if (edits.size === 0) {
    return false;
  }
  const normalized = normalize(path);
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return edits.has(normalized) || [...edits].some((edit) => normalize(edit).endsWith(`/${name}`));
}

function importMatchesPath(specifier: string, basename: string, path: string): boolean {
  const spec = normalize(specifier).replace(/^\.\//, '');
  const target = normalize(path);
  const targetName = target.slice(target.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return target.includes(spec.replace(/\.[^.]+$/, '')) || spec.includes(targetName) || basename.startsWith(targetName);
}

function entryLine(entry: RepoMapEntry): string {
  const symbols = entry.symbols.slice(0, 8).join(', ');
  const imports = entry.imports.slice(0, 6).join(', ');
  if (symbols && imports) {
    return `${entry.path}: ${symbols} (imports ${imports})`;
  }
  if (symbols) {
    return `${entry.path}: ${symbols}`;
  }
  return `${entry.path} imports ${imports}`;
}

function bound(text: string, caps: RepoMapCaps): string {
  if (text.length <= caps.maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, caps.maxChars - 1))}…`;
}
