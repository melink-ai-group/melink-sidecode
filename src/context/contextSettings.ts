/**
 * The project-context defaults the settings screen owns.
 *
 * This module is host-free: it names the setting keys, the shape of the
 * resolved settings, and the one pattern validator. The thin VS Code reader
 * lives in `vscodeHost.ts`, and the snapshot and injection paths consume this
 * type, so the screen writes exactly the keys those paths read.
 *
 * Every category of the picture can be turned off. A disabled category is never
 * sent, and the two sensitive categories - editor state and the current
 * selection - are not even read, so turning them off removes the content rather
 * than merely hiding it.
 */

/** The setting keys, named once so the reader and the screen cannot drift. */
export const CONTEXT_SECTION = 'melink.context';

export interface ContextSettings {
  /** Include instruction documents (AGENTS.md, README.md, copilot instructions). */
  includeInstructions: boolean;
  /** Include project shape (languages, tree, manifests). */
  includeShape: boolean;
  /** Follow the active file and open editors. When off, no editor read happens. */
  includeEditorState: boolean;
  /** Quote the current selection. When off, the selected text is never read. */
  includeSelection: boolean;
  /** Include the changed-files notice in a per-turn delta. */
  includeChangedFiles: boolean;
  /** Overall byte cap for a rendered snapshot block. */
  maxBytes: number;
  /** Extra glob patterns excluded from the snapshot, additive to the built-ins. */
  exclude: string[];
  /**
   * Optional bounded symbol/import map queried per turn. Optional so a host or
   * fake from before the map existed stays off rather than silently enabling a
   * new read. The documented default is `false`.
   */
  repoMap?: boolean;
  /** Files the map may read per build. */
  repoMapMaxFiles?: number;
  /** Bytes the map may read per build. */
  repoMapMaxBytes?: number;
  /** Wall-clock budget for one map build. */
  repoMapBuildMs?: number;
  /** Character cap for the rendered per-turn map block. */
  repoMapMaxChars?: number;
}

/** The documented defaults, mirrored in `package.json`. */
export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  includeInstructions: true,
  includeShape: true,
  includeEditorState: true,
  includeSelection: true,
  includeChangedFiles: true,
  maxBytes: 20_480,
  exclude: [],
  repoMap: false,
  repoMapMaxFiles: 200,
  repoMapMaxBytes: 131_072,
  repoMapBuildMs: 750,
  repoMapMaxChars: 1_200
};

/**
 * The smallest sane cap: below this a snapshot would carry almost nothing, so a
 * smaller value is refused as an invalid entry rather than silently stored.
 */
export const MIN_CONTEXT_BYTES = 1_024;
/** The largest cap the screen accepts, so a typo cannot disable the bound. */
export const MAX_CONTEXT_BYTES = 1_048_576;

/**
 * Validate one extra ignore pattern. Returns a plain-language message when the
 * pattern is unusable, so the screen can mark it "not saved" instead of
 * silently dropping it. The matcher escapes glob metacharacters, so the check
 * is about obviously malformed input: empty, unbalanced brackets/braces, or a
 * lone backslash.
 */
export function contextPatternError(pattern: string): string | undefined {
  const value = pattern.trim();
  if (!value) {
    return 'Enter a pattern, or remove the row. This value was not saved.';
  }
  if (!balanced(value, '[', ']')) {
    return 'Pattern not saved. A "[" needs a matching "]". The previous list stays in effect.';
  }
  if (!balanced(value, '{', '}')) {
    return 'Pattern not saved. A "{" needs a matching "}". The previous list stays in effect.';
  }
  if (value.endsWith(String.fromCharCode(92))) {
    return 'Pattern not saved. A pattern cannot end with a "\\". The previous list stays in effect.';
  }
  return undefined;
}

function balanced(value: string, open: string, close: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}
