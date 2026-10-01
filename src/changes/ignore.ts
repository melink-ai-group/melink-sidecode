/**
 * Directory names that are never a conversation change. `node_modules` and VCS
 * metadata are ignored even when a workspace forgets to list them. `.opencode`
 * is the opencode CLI's own project state (its lockfile and install tree), not
 * a file the agent edited for the user.
 */
const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.hg', '.svn', 'bower_components', '.opencode']);

function posix(path: string): string {
  return path.replace(/\\/g, '/');
}

/** True when any path segment is a directory the review must not attribute to a turn. */
export function hasIgnoredSegment(relPath: string): boolean {
  return posix(relPath)
    .split('/')
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

/**
 * True when a workspace-relative path is gitignored or sits in an ignored
 * directory. `gitignore` is the text of the root `.gitignore`, when one exists.
 * A pattern the file does not mention is not ignored, except for the fixed
 * directory names above.
 */
export function isIgnoredRelPath(relPath: string, gitignore?: string): boolean {
  const normalized = posix(relPath).replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized.length === 0 || hasIgnoredSegment(normalized)) {
    return true;
  }
  if (!gitignore) {
    return false;
  }
  return gitignoreMatches(normalized, gitignore);
}

/** Last matching rule wins, including a later `!` negation. */
function gitignoreMatches(relPath: string, text: string): boolean {
  let ignored = false;
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
    if (ruleMatches(relPath, pattern)) {
      ignored = !negated;
    }
  }
  return ignored;
}

function ruleMatches(relPath: string, pattern: string): boolean {
  const anchored = pattern.startsWith('/');
  let body = anchored ? pattern.slice(1) : pattern;
  const directory = body.endsWith('/');
  if (directory) {
    body = body.slice(0, -1);
  }
  if (body.length === 0) {
    return false;
  }
  const expression = globToRegExp(body);
  if (anchored || pattern.includes('/')) {
    return pathMatches(relPath, expression, directory);
  }
  const parts = relPath.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const suffix = parts.slice(index).join('/');
    if (pathMatches(suffix, expression, directory)) {
      return true;
    }
  }
  return false;
}

/** A pattern matches the path itself, or a directory and everything inside it. */
function pathMatches(relPath: string, expression: RegExp, directory: boolean): boolean {
  if (expression.test(relPath)) {
    return true;
  }
  const slash = relPath.indexOf('/');
  if (slash === -1) {
    return false;
  }
  const parent = relPath.slice(0, slash);
  return expression.test(parent) && (directory || true);
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
