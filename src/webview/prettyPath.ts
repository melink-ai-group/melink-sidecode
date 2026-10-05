/**
 * Visual paths for the chat transcript.
 *
 * Both Ollama and Codex render through the same cards, so one function
 * shortens every path the conversation shows. A path inside a workspace root
 * becomes workspace-relative. Any other absolute path drops the drive and a
 * home or work parent, so the line starts at the project instead of the disk
 * root. Relative text is left as it is. Hover still carries the full visual
 * line; this function does not clip it.
 */

let roots: readonly string[] = [];

/** Workspace folders the host last reported. Later calls to `prettyPath` use them. */
export function setPrettyPathRoots(next: readonly string[]): void {
  roots = next;
}

/** The project-relative form of `value`, including absolute paths embedded in a command. */
export function prettyPath(value: string, pathRoots: readonly string[] = roots): string {
  if (!value) {
    return value;
  }
  return value.replace(ABSOLUTE_PATH, (match, offset: number, whole: string) => {
    const prev = offset > 0 ? whole[offset - 1] : '';
    // Leave `https://...` and protocol-relative URLs alone.
    if (prev === '/' || prev === ':') {
      return match;
    }
    return projectPath(match, pathRoots);
  });
}

/**
 * Windows drive paths and Unix absolute paths.
 * The lookbehind keeps a slash inside a relative path or a URL from matching.
 */
const ABSOLUTE_PATH =
  /(?<![^\s"'`(])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+|(?<![^\s"'`(])\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+/g;

/** A directory that sits above the project (`C:\work\...`, `~/projects/...`). */
const WORK_PARENT = /^(?:work(?:[-_].+)?|projects|repos|dev|code|source|documents)$/i;

function projectPath(absolute: string, pathRoots: readonly string[]): string {
  const posix = absolute.replace(/\\/g, '/').replace(/\/+$/, '');
  const relative = relativeToRoots(posix, pathRoots);
  if (relative !== undefined) {
    return relative || fileName(posix);
  }
  return outsideProject(posix);
}

function relativeToRoots(posix: string, pathRoots: readonly string[]): string | undefined {
  const lower = posix.toLowerCase();
  let best: string | undefined;
  let bestLen = -1;
  for (const root of pathRoots) {
    const norm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) {
      continue;
    }
    const rootLower = norm.toLowerCase();
    if (lower === rootLower) {
      if (norm.length > bestLen) {
        best = '';
        bestLen = norm.length;
      }
      continue;
    }
    if (lower.startsWith(`${rootLower}/`) && norm.length > bestLen) {
      best = posix.slice(norm.length + 1);
      bestLen = norm.length;
    }
  }
  return best;
}

/**
 * Absolute path outside every workspace root. Drop the drive, then a home
 * directory and one work parent, and keep the project path that remains.
 */
function outsideProject(posix: string): string {
  const parts = posix.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '').split('/').filter(Boolean);
  let index = 0;
  if (parts[index] && /^(users|home|root)$/i.test(parts[index])) {
    index += 1;
    if (parts[index]) {
      index += 1;
    }
  }
  if (parts[index] && WORK_PARENT.test(parts[index])) {
    index += 1;
  }
  const kept = parts.slice(index);
  if (kept.length === 0) {
    return fileName(posix);
  }
  return kept.join('/');
}

function fileName(posix: string): string {
  const slash = posix.lastIndexOf('/');
  return slash >= 0 ? posix.slice(slash + 1) : posix;
}
