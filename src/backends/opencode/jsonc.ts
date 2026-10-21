/** Minimal JSONC helpers shared by the reader and the comment-preserving editor. */

/** Drop `//` and block comments, leaving string contents in place. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const current = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (current === '"' || current === "'") {
      const quote = current;
      out += current;
      i += 1;
      while (i < text.length) {
        const ch = text[i] ?? '';
        out += ch;
        if (ch === '\\') {
          const escaped = text[i + 1];
          if (escaped !== undefined) {
            out += escaped;
          }
          i += 2;
          continue;
        }
        i += 1;
        if (ch === quote) {
          break;
        }
      }
      continue;
    }
    if (current === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (current === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(text.length, i + 2);
      continue;
    }
    out += current;
    i += 1;
  }
  return out;
}

/**
 * Drop trailing commas before `}` / `]`.
 *
 * JSONC allows them; `JSON.parse` does not. Without this a single trailing
 * comma made the reader return `{}`, and the next upsert rewrote the file with
 * only the MCP map, losing `$schema`, `provider`, `theme` and every other key.
 */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const current = text[i] ?? '';
    if (current === '"') {
      out += current;
      i += 1;
      while (i < text.length) {
        const ch = text[i] ?? '';
        out += ch;
        if (ch === '\\') {
          const escaped = text[i + 1];
          if (escaped !== undefined) {
            out += escaped;
          }
          i += 2;
          continue;
        }
        i += 1;
        if (ch === '"') {
          break;
        }
      }
      continue;
    }
    if (current === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) {
        j += 1;
      }
      const next = text[j] ?? '';
      if (next === '}' || next === ']') {
        i += 1;
        continue;
      }
    }
    out += current;
    i += 1;
  }
  return out;
}

const BOM = '\uFEFF';

/** Parse an OpenCode config as JSONC (comments and trailing commas allowed). */
export function parseOpencodeConfig(
  text: string
): { data: Record<string, unknown>; error?: string } {
  const trimmed = (text.startsWith(BOM) ? text.slice(BOM.length) : text).trim();
  if (trimmed.length === 0) {
    return { data: {} };
  }
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(trimmed))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {}, error: 'the root value is not a JSON object' };
    }
    return { data: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      data: {},
      error: error instanceof Error ? error.message : 'it could not be parsed as JSON'
    };
  }
}
