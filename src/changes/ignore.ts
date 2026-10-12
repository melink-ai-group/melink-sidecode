/**
 * Directory names that are never a conversation change. `node_modules` and VCS
 * metadata are ignored even when a workspace forgets to list them. `.opencode`
 * is the opencode CLI's own project state (its lockfile and install tree), not
 * a file the agent edited for the user. `dist` and the other names are build
 * output: a production build rewrites them, and they are not the source file
 * the turn edited.
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'bower_components',
  '.opencode',
  'dist',
  'dist-ssr',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.output',
  'storybook-static',
  '__pycache__'
]);

function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** True when any path segment is a directory the review must not attribute to a turn. */
export function hasIgnoredSegment(relPath: string): boolean {
  return posix(relPath)
    .split('/')
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** One `.gitignore`, rooted at a workspace-relative directory. `''` is the workspace root. */
export interface GitignoreSource {
  directory: string;
  text: string;
}

/**
 * True when a workspace-relative path is gitignored or sits in an ignored
 * directory. `gitignore` is the text of the root `.gitignore`, when one exists.
 * A pattern the file does not mention is not ignored, except for the fixed
 * directory names above.
 */
export function isIgnoredRelPath(relPath: string, gitignore?: string): boolean {
  const sources = gitignore ? [{ directory: '', text: gitignore }] : [];
  return excludedByIgnore(relPath, sources);
}

/**
 * True when any `.gitignore` from the workspace root down to the file excludes
 * the path. Parent files are applied first; a later rule, including one in a
 * deeper `.gitignore`, wins. A negation cannot bring back a file whose parent
 * directory is excluded.
 */
export function excludedByIgnore(relPath: string, sources: readonly GitignoreSource[]): boolean {
  const normalized = posix(relPath).replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized.length === 0 || hasIgnoredSegment(normalized)) {
    return true;
  }
  const state: IgnoreState = { ignored: false, excludedDirs: [] };
  const ordered = [...sources].sort((a, b) => directoryDepth(a.directory) - directoryDepth(b.directory));
  for (const source of ordered) {
    const directory = posix(source.directory).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
    if (directory && normalized !== directory && !normalized.startsWith(`${directory}/`)) {
      continue;
    }
    const local = directory ? normalized.slice(directory.length + 1) : normalized;
    if (local.length === 0) {
      continue;
    }
    applyRules(normalized, directory, local, source.text, state);
  }
  return state.ignored;
}

/** A binary, an ignored directory, or a gitignored path is not a review row. */
export function listedForReview(
  file: { binary: boolean; relPath: string },
  sources: readonly GitignoreSource[]
): boolean {
  return !file.binary && !excludedByIgnore(file.relPath, sources);
}

/**
 * The workspace root that contains `relPath`, derived from the absolute path.
 * Undefined when the relative path is not a suffix of the absolute path.
 */
export function workspaceRootOf(absPath: string, relPath: string): string | undefined {
  const abs = posix(absPath).replace(/\/+$/, '');
  const rel = posix(relPath).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (rel.length === 0) {
    return abs;
  }
  const suffix = `/${rel}`;
  if (!abs.endsWith(suffix)) {
    return undefined;
  }
  return abs.slice(0, -suffix.length);
}

/**
 * Every `.gitignore` from the workspace root down to the parent of `relPath`.
 * A missing file is cached as absent so a review of many files reads each
 * `.gitignore` once.
 */
export async function reviewSources(
  root: string,
  relPath: string,
  readFile: (absPath: string) => Promise<Uint8Array | undefined>,
  cache: Map<string, string | null>
): Promise<GitignoreSource[]> {
  const base = posix(root).replace(/\/+$/, '');
  const sources: GitignoreSource[] = [];
  for (const directory of parentDirectories(relPath)) {
    const filePath = directory ? `${base}/${directory}/.gitignore` : `${base}/.gitignore`;
    let text = cache.get(filePath);
    if (text === undefined) {
      const bytes = await readFile(filePath);
      text = bytes ? new TextDecoder().decode(bytes) : null;
      cache.set(filePath, text);
    }
    if (text) {
      sources.push({ directory, text });
    }
  }
  return sources;
}

/** Files the changes strip and the review page should show, in the same order. */
export async function filterListedFiles<T extends { absPath: string; relPath: string; binary: boolean }>(
  files: readonly T[],
  readFile: (absPath: string) => Promise<Uint8Array | undefined>
): Promise<T[]> {
  const cache = new Map<string, string | null>();
  const listed: T[] = [];
  for (const file of files) {
    const root = workspaceRootOf(file.absPath, file.relPath);
    const sources = root ? await reviewSources(root, file.relPath, readFile, cache) : [];
    if (listedForReview(file, sources)) {
      listed.push(file);
    }
  }
  return listed;
}

interface IgnoreState {
  ignored: boolean;
  /** Workspace-relative directory prefixes a rule excluded. */
  excludedDirs: string[];
}

type RuleMatch = { kind: 'file' } | { kind: 'dir'; prefix: string };

function directoryDepth(directory: string): number {
  const normalized = posix(directory).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/$/, '');
  return normalized.length === 0 ? 0 : normalized.split('/').length;
}

/** Parent directories of a file, starting at the workspace root. */
function parentDirectories(relPath: string): string[] {
  const parts = posix(relPath).replace(/^\.\//, '').replace(/^\/+/, '').split('/').filter((part) => part.length > 0);
  parts.pop();
  const dirs = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    dirs.push(acc);
  }
  return dirs;
}

function applyRules(fullPath: string, directory: string, localPath: string, text: string, state: IgnoreState): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const negated = line.startsWith('!');
    const pattern = (negated ? line.slice(1) : line).trim();
    if (pattern.length === 0 || pattern.startsWith('#')) {
      continue;
    }
    const matched = classifyMatch(localPath, pattern);
    if (!matched) {
      continue;
    }
    if (!negated) {
      state.ignored = true;
      if (matched.kind === 'dir') {
        state.excludedDirs.push(joinDir(directory, matched.prefix));
      }
      continue;
    }
    if (matched.kind === 'dir') {
      const prefix = joinDir(directory, matched.prefix);
      if (parentExcluded(prefix, state.excludedDirs)) {
        continue;
      }
      state.excludedDirs = state.excludedDirs.filter((dir) => dir !== prefix && !dir.startsWith(`${prefix}/`));
      state.ignored = contained(fullPath, state.excludedDirs);
      continue;
    }
    if (!contained(fullPath, state.excludedDirs)) {
      state.ignored = false;
    }
  }
}

function joinDir(directory: string, prefix: string): string {
  return directory.length === 0 ? prefix : `${directory}/${prefix}`;
}

function contained(relPath: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`));
}

function parentExcluded(dir: string, dirs: readonly string[]): boolean {
  return dirs.some((excluded) => excluded !== dir && dir.startsWith(`${excluded}/`));
}

function classifyMatch(relPath: string, pattern: string): RuleMatch | undefined {
  const anchored = pattern.startsWith('/');
  let body = anchored ? pattern.slice(1) : pattern;
  const directory = body.endsWith('/');
  if (directory) {
    body = body.slice(0, -1);
  }
  if (body.length === 0) {
    return undefined;
  }
  const expression = globToRegExp(body);
  if (anchored || pattern.includes('/')) {
    return classifyPath(relPath, expression, directory);
  }
  const parts = relPath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join('/');
    const found = classifyPath(suffix, expression, directory);
    if (!found) {
      continue;
    }
    if (found.kind === 'file') {
      return found;
    }
    const lead = parts.slice(0, index);
    const prefix = [...lead, ...found.prefix.split('/')].filter((part) => part.length > 0).join('/');
    return { kind: 'dir', prefix };
  }
  return undefined;
}

function classifyPath(relPath: string, expression: RegExp, directory: boolean): RuleMatch | undefined {
  if (expression.test(relPath)) {
    return directory ? { kind: 'dir', prefix: relPath } : { kind: 'file' };
  }
  // A rule that names a directory ignores every file inside it, not only the
  // directory's first segment. `**/dist` must hide `frontend/dist/index.html`.
  const parts = relPath.split('/');
  let acc = '';
  for (let index = 0; index < parts.length - 1; index += 1) {
    acc = acc ? `${acc}/${parts[index]}` : parts[index];
    if (expression.test(acc)) {
      return { kind: 'dir', prefix: acc };
    }
  }
  return undefined;
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
