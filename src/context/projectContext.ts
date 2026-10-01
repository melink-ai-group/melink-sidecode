import {
  DEFAULT_CONTEXT_SETTINGS,
  type ContextSettings
} from './contextSettings.ts';

/**
 * The single source of project awareness.
 *
 * This module builds one bounded picture of the open project - workspace
 * identity, project shape, instruction documents, and editor state - so a
 * backend can be handed a workspace picture before the user asks a question.
 * Nothing here talks to a provider: it reads through an injected VS Code API
 * surface and returns typed protocol data.
 *
 * ## Host-free by construction
 *
 * The module never imports `vscode`. Every host call goes through
 * `ProjectContextHost`, a structural interface describing exactly the reads the
 * snapshot needs. That keeps `npm test` headless: the unit tests inject a fake
 * host and never touch a VS Code runtime. The thin adapter that binds the real
 * `vscode` API to this interface belongs outside this file, because that is the
 * only part that needs the host.
 *
 * ## Invariants
 *
 * - **Bounded.** Every category has a fixed byte cap and every snapshot has an
 *   overall cap. Excerpts are byte-truncated before they are stored, so no
 *   category body can exceed its cap and the ordering is deterministic.
 * - **Partial views are marked.** A category whose cap bit carries an explicit
 *   `… truncated (N of M entries)` marker, so a model is told it is seeing a
 *   partial view rather than assuming completeness.
 * - **Excluded means unread.** `.env`-style secret stores, key material,
 *   `node_modules`, `.git`, build output, binaries, lockfile bodies and anything
 *   matched by `files.exclude`/`search.exclude` or the user's patterns are never
 *   read. A selection inside an excluded file is reported as excluded rather
 *   than quoted.
 * - **Empty categories are explicit.** A category with nothing in it says so
 *   rather than being silently omitted.
 * - **Cheap to refresh.** Only editor state changes constantly; the snapshot is
 *   cached by workspace root and invalidated on structural changes, so typing
 *   never rebuilds the tree.
 */

/** How an entry was excluded, so the snapshot can be honest without quoting it. */
export type ExclusionReason =
  | 'secret'
  | 'key-material'
  | 'dependency'
  | 'vcs'
  | 'build'
  | 'binary'
  | 'lockfile'
  | 'excluded'
  | 'user';

/** A path that was refused, and why. No content is ever attached. */
export interface ExcludedPath {
  path: string;
  reason: ExclusionReason;
}

/** Workspace identity: enough to tell the model where it is, and no more. */
export interface WorkspaceIdentity {
  /** Folder name(s), in workspace order. */
  names: string[];
  /** Absolute root path(s), in workspace order, one per folder. */
  roots: string[];
  /** True when the workspace has more than one root. */
  multiRoot: boolean;
  /** True when a git branch or remote was observed for the primary root. */
  isGitRepo: boolean;
  /** Branch of the primary root, or `null` when not a git repo / detached. */
  branch: string | null;
  /** `owner/repo` from the primary root's remote, when available. */
  remote: string | null;
  /** Category truncation marker, or `null` when nothing was cut. */
  truncated: string | null;
}

/** One language bucket in the file-count breakdown. */
export interface LanguageCount {
  language: string;
  files: number;
}

/** A bounded directory tree entry. */
export interface DirectoryNode {
  /** Workspace-relative path, POSIX separators; `''` is the root. */
  path: string;
  /** Name shown for this node. */
  name: string;
  /** Depth from the root; top-level entries are depth 1. */
  depth: number;
  /** Number of entries directly inside, for a hint of size. */
  entries: number;
}

/** A manifest or entry point that was detected. */
export interface ManifestHit {
  /** Workspace-relative path. */
  path: string;
  /** The kind of manifest/entry point, e.g. `package.json` or `src/`. */
  kind: string;
  /** Small structured fields read out of the manifest, never its body. */
  fields?: Record<string, string>;
}

export interface ProjectShape {
  languages: LanguageCount[];
  tree: DirectoryNode[];
  manifests: ManifestHit[];
  /**
   * Workspace-relative paths of the files the bounded walk actually read,
   * sorted and deduplicated. This is what makes a file added or removed between
   * two snapshots visible to `getDelta`; it is capped like every other list.
   */
  files: string[];
  /** Total files considered when building the breakdown, before any cap. */
  totalFiles: number;
  /** True when the language breakdown itself was capped. */
  languagesTruncated: boolean;
  /** Human-readable truncation marker, or `null` when nothing was cut. */
  truncated: string | null;
}

/** An instruction document, included as a bounded excerpt. */
export interface InstructionDocument {
  path: string;
  /** Which document this is, e.g. `agents`, `readme`, `copilot`. */
  kind: string;
  /** Bounded excerpt, never the whole file when it is large. */
  excerpt: string;
  truncated: boolean;
}

export interface InstructionDocs {
  documents: InstructionDocument[];
  /** True when the whole category is empty; the snapshot says so explicitly. */
  noneFound: boolean;
  truncated: string | null;
}

/** The current selection range and the selected text. */
export interface EditorSelection {
  /** One-based start line/column. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** The selected text, bounded; `null` when the selection is empty. */
  text: string | null;
  /** True when the selected text was cut to fit the excerpt cap. */
  truncated: boolean;
}

/** The active file and its selection, the "current page". */
export interface ActiveEditorState {
  absolutePath: string;
  relativePath: string | null;
  languageId: string;
  selection: EditorSelection | null;
  /** True when the active file is excluded; the selection is then not quoted. */
  excluded: boolean;
  exclusionReason?: ExclusionReason;
}

/** One open/visible editor. */
export interface OpenEditor {
  absolutePath: string;
  relativePath: string | null;
  languageId: string;
  isActive: boolean;
  isDirty: boolean;
}

export interface EditorState {
  active: ActiveEditorState | null;
  openEditors: OpenEditor[];
  dirtyFiles: string[];
  /** The active terminal's cwd, or `null` when no terminal is open. */
  terminalCwd: string | null;
  truncated: string | null;
  /**
   * Set only on the copy handed to the renderer.
   * `false`: do not name a current file.
   * `true`: a separate per-turn block carries the file the user attached.
   */
  activeFileAttached?: boolean;
}

/** Per-category byte caps, plus the overall cap. Every value is a byte count. */
export interface ContextBudget {
  identity: number;
  shape: number;
  instructions: number;
  editor: number;
  overall: number;
  /** Largest number of tree nodes described. */
  treeEntries: number;
  /** Largest number of files in the language breakdown. */
  languageEntries: number;
  /** Largest number of file paths carried for change detection. */
  fileEntries: number;
  /** Largest number of open editors listed. */
  editorEntries: number;
  /** Largest number of instruction documents listed. */
  documentEntries: number;
  /** Deepest nested instruction-document directory that is scanned. */
  instructionDepth: number;
  /** Largest number of files walked when building project shape. */
  scanLimit: number;
  /** Largest excerpt length for one instruction document or selection. */
  excerptBytes: number;
}

/** Largest excerpt of an explicitly attached file. The rest is marked truncated. */
export const ATTACHED_FILE_BYTES = 12_288;

export const DEFAULT_BUDGET: ContextBudget = {
  identity: 2_048,
  shape: 6_144,
  instructions: 7_168,
  editor: 4_096,
  overall: 20_480,
  treeEntries: 80,
  languageEntries: 12,
  fileEntries: 300,
  editorEntries: 20,
  documentEntries: 8,
  instructionDepth: 3,
  scanLimit: 2_000,
  excerptBytes: 1_024
};

/** Directory names the default ignore set refuses, wherever they appear. */
export const IGNORED_DIRECTORIES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'bin',
  'obj',
  'target',
  'coverage',
  '.next',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.cache'
];

/** Directory names whose refusal is specifically a dependency store. */
const DEPENDENCY_DIRECTORIES: readonly string[] = ['node_modules', 'vendor', '.venv', 'venv', '__pycache__'];

/** Lockfiles whose bodies are never read, though their names are not secret. */
export const LOCKFILES: readonly string[] = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'composer.lock',
  'gemfile.lock'
];

/** Extensions treated as binaries, never read for excerpts. */
const BINARY_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.bin', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav'
];

/** Extensions and names treated as key material, never read. */
const KEY_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'];
const KEY_NAMES: readonly string[] = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/** One immediate child of a directory, as reported by the host listing. */
export interface DirectoryEntry {
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
}

/**
 * The injected VS Code API surface. Every method is the smallest read the
 * snapshot needs, so a fake host is trivial and the real adapter is thin.
 */
export interface ProjectContextHost {
  /**
   * Absolute paths of every workspace root, in workspace order. An empty array
   * is a window with no folder open; the snapshot reports that rather than
   * pretending a workspace exists.
   */
  workspaceRoots(): string[];
  /** Reads a UTF-8 text file, or `undefined` when it does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /** Lists the immediate children of an absolute directory path. */
  listDirectory(directory: string): Promise<readonly DirectoryEntry[]>;
  /** The git branch of a root, or `null` when unknown/not a repo. */
  gitBranch(root: string): Promise<string | null>;
  /** The `owner/repo` remote of a root, or `null` when unknown. */
  gitRemote(root: string): Promise<string | null>;
  /**
   * The active editor's identity and selection *range*, or `null` when no
   * editor is active. The selected text is deliberately absent: the module
   * classifies the path first and only calls `activeSelectionText()` when the
   * file is not excluded, so a secret is never read at all.
   */
  activeEditor(): {
    absolutePath: string;
    languageId: string;
    selection: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    } | null;
  } | null;
  /**
   * The selected text of the active editor. Called only when the active file is
   * not excluded, so exclusion applies before any read.
   */
  activeSelectionText(): string;
  /** Every visible editor, in host order. */
  openEditors(): readonly {
    absolutePath: string;
    languageId: string;
    isActive: boolean;
    isDirty: boolean;
  }[];
  /**
   * Text of the file the user is viewing, including unsaved edits. Called only
   * after the path has been classified as safe to read.
   */
  activeFileText?(): string;
  /** Paths of dirty files (whether or not they are visible). */
  dirtyFiles(): readonly string[];
  /** The active terminal's cwd, or `null` when no terminal is open. */
  terminalCwd?(): Promise<string | null>;
  /**
   * The project-context defaults the settings screen writes. Optional, and
   * allowed to return `undefined`, so every existing fake host keeps working and
   * a test can distinguish "no settings" (respect an injected budget) from
   * "documented defaults". An absent read means the documented defaults, so the
   * snapshot is never accidentally unbounded.
   */
  contextSettings?(): ContextSettings | undefined;
  /** `files.exclude` globs, read from configuration. */
  filesExclude(): readonly string[];
  /** `search.exclude` globs, read from configuration. */
  searchExclude(): readonly string[];
  /** User-configured ignore patterns, on top of the default set. */
  userExclude(): readonly string[];
  /** Epoch milliseconds, injected so tests are deterministic. */
  now(): number;
}

export interface GetSnapshotInput {
  /**
   * Paths the host learned from an event rather than from a directory walk (for
   * example a file created since the last snapshot). They are folded into the
   * shape, or reported as excluded when they match the ignore set.
   */
  changedPaths?: readonly string[];
}

export interface ProjectSnapshotOptions {
  budget?: ContextBudget;
  host: ProjectContextHost;
}

/** The full picture, ready to hand to a backend. */
export interface ProjectSnapshot {
  /** Epoch milliseconds the snapshot was built. */
  timestamp: number;
  workspace: WorkspaceIdentity;
  shape: ProjectShape;
  instructions: InstructionDocs;
  editor: EditorState;
  /** The default exclusion list in effect, for the model's benefit. */
  exclusions: {
    directories: string[];
    patterns: string[];
    /** The user's own patterns, kept separate so they can be attributed. */
    user: string[];
  };
  /** Every path that was refused, with a reason and no content. */
  excludedPaths: ExcludedPath[];
  /** Overall marker when the snapshot exceeded the overall byte cap. */
  truncated: string | null;
}

/** What changed between two snapshots. Empty when nothing meaningful changed. */
export interface ProjectDelta {
  changed: boolean;
  workspace?: boolean;
  files?: { added: string[]; removed: string[] } | null;
  activeEditor?: boolean;
  selection?: boolean;
  openEditors?: boolean;
  dirtyFiles?: string[];
  terminalCwd?: boolean;
  gitBranch?: boolean;
}

/** The two reads the service exposes. */
export interface ProjectContextReads {
  getSnapshot(input?: GetSnapshotInput): Promise<ProjectSnapshot>;
  getDelta(previous: ProjectSnapshot, current?: ProjectSnapshot): Promise<ProjectDelta>;
  /**
   * The context defaults in effect. Optional so a fake reads source in a test
   * need not supply them; an absent read means the documented defaults.
   */
  contextSettings?(): ContextSettings;
  /**
   * The file the user is viewing, read only when that path is safe. Absent when
   * no file is open. The renderer turns this into the per-turn block.
   */
  viewedFileAttachment?(): Promise<ViewedFileAttachment | undefined>;
}

/** The current file, ready to render. Contents are absent when the path is excluded. */
export interface ViewedFileAttachment {
  path: string;
  languageId: string;
  excluded: boolean;
  exclusionReason?: ExclusionReason;
  text?: string;
  truncated?: boolean;
  selection?: string;
}

/* -------------------------------------------------------------------------- */
/* Classification and glob matching                                           */
/* -------------------------------------------------------------------------- */

/** Case-insensitive basename, for the extension/name checks below. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return (index === -1 ? normalized : normalized.slice(index + 1)).toLowerCase();
}

/** POSIX-style path with no leading `./`. */
function toPosix(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * A glob matcher for `files.exclude` / `search.exclude` style patterns.
 *
 * Supports the subset VS Code uses in practice: `*` (within a segment), `**`
 * (across segments), `?`, a leading `/` to anchor at the root, and a trailing
 * `/` to require a directory. An unanchored pattern is also tested against each
 * path segment, so a bare `node_modules` matches it wherever it appears.
 */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  if (!pattern) {
    return false;
  }
  const posix = toPosix(relativePath).replace(/^\/+/, '');
  let glob = toPosix(pattern).replace(/^\.\//, '');
  if (glob.endsWith('/')) {
    glob = glob.slice(0, -1);
  }
  const anchored = glob.startsWith('/');
  if (anchored) {
    glob = glob.slice(1);
  }
  const source = globToRegExp(glob);
  if (source === null) {
    return false;
  }
  const regex = new RegExp(`^${source}$`, 'i');
  if (anchored) {
    return regex.test(posix);
  }
  if (regex.test(posix)) {
    return true;
  }
  // An unanchored pattern matches at any depth, so every path suffix and every
  // single segment is tested: `private/**` catches `a/private/x` and `dist`
  // catches `packages/app/dist`.
  const segments = posix.split('/');
  for (let start = 0; start < segments.length; start += 1) {
    if (regex.test(segments.slice(start).join('/'))) {
      return true;
    }
  }
  return segments.some((segment) => regex.test(segment));
}

function globToRegExp(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface GlobOptions {
  patterns: readonly string[];
  user: readonly string[];
  root?: string;
}

/**
 * Classify one path against the default ignore set and the configured globs.
 *
 * The order is deliberate: secret stores and key material are recognized first
 * so a path is never read even if a user pattern would otherwise include it. A
 * dependency or VCS directory anywhere in the path wins over a later rule.
 */
export function classifyPath(path: string, options: GlobOptions): { excluded: boolean; reason?: ExclusionReason } {
  const posix = toPosix(path);
  const lower = posix.toLowerCase();
  const rel = options.root ? relativeToRoot(posix, toPosix(options.root)) : posix;
  const segments = rel.split('/').filter((segment) => segment.length > 0);
  const name = basename(posix);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';

  // .env files and dotfile secret stores.
  if (name === '.env' || name.startsWith('.env.') || name === '.envrc') {
    return { excluded: true, reason: 'secret' };
  }
  if (
    name === '.npmrc' ||
    name === '.netrc' ||
    name === '.htpasswd' ||
    name === 'credentials' ||
    name === 'secrets.json'
  ) {
    return { excluded: true, reason: 'secret' };
  }
  // Key material, by name or extension.
  if (KEY_NAMES.includes(name) || KEY_EXTENSIONS.includes(extension)) {
    return { excluded: true, reason: 'key-material' };
  }
  // Dependency stores anywhere in the path.
  if (segments.some((segment) => DEPENDENCY_DIRECTORIES.includes(segment.toLowerCase()))) {
    return { excluded: true, reason: 'dependency' };
  }
  // The VCS metadata directory.
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return { excluded: true, reason: 'vcs' };
  }
  // Any other dot-directory except `.github`, which holds instruction files.
  if (segments.some((segment) => segment.startsWith('.') && segment.toLowerCase() !== '.github')) {
    return { excluded: true, reason: 'excluded' };
  }
  // Build output by directory name, then by a few build extensions.
  if (segments.some((segment) => ['dist', 'out', 'build', 'coverage', 'bin', 'obj', 'target', '.next'].includes(segment.toLowerCase()))) {
    return { excluded: true, reason: 'build' };
  }
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css') || lower.endsWith('.map')) {
    return { excluded: true, reason: 'build' };
  }
  // Binaries.
  if (BINARY_EXTENSIONS.includes(extension)) {
    return { excluded: true, reason: 'binary' };
  }
  // Lockfile bodies.
  if (LOCKFILES.includes(name)) {
    return { excluded: true, reason: 'lockfile' };
  }
  // Configured globs, then the user's own patterns.
  if (options.patterns.some((pattern) => matchesGlob(pattern, rel))) {
    return { excluded: true, reason: 'excluded' };
  }
  if (options.user.some((pattern) => matchesGlob(pattern, rel))) {
    return { excluded: true, reason: 'user' };
  }
  return { excluded: false };
}

function relativeToRoot(path: string, root: string): string {
  const normalizedRoot = root.replace(/\/+$/, '');
  if (path.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
    return path.slice(normalizedRoot.length + 1);
  }
  return path;
}

/* -------------------------------------------------------------------------- */
/* Text and byte helpers                                                      */
/* -------------------------------------------------------------------------- */

/** A byte count, so a cap is measured in bytes rather than characters. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function jsonBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

/**
 * Truncate on a UTF-8 boundary at or below `maxBytes`. A multi-byte character
 * is never split, because the result would not survive the crossing.
 */
export function cutToBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  let end = value.length;
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return { text: value.slice(0, end), truncated: true };
}

/** The one marker shape every capped category shares. */
export function truncationMarker(shown: number, total: number): string {
  return `… truncated (${shown} of ${total} entries)`;
}

function markerJoin(existing: string | null, marker: string): string {
  return existing ? `${existing}; ${marker}` : marker;
}

/** A bounded single-line excerpt of a document. */
function excerptOf(value: string, maxBytes: number): { text: string; truncated: boolean } {
  return cutToBytes(value.replace(/\r\n/g, '\n').trim(), maxBytes);
}

/* -------------------------------------------------------------------------- */
/* Project shape helpers                                                      */
/* -------------------------------------------------------------------------- */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.swift': 'Swift',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.html': 'HTML',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.sql': 'SQL',
  '.vue': 'Vue',
  '.svelte': 'Svelte'
};

/** The language name for a path, or `Other` when the extension is unknown. */
export function languageForPath(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    return 'Other';
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot)] ?? 'Other';
}

const MANIFEST_KINDS: readonly string[] = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'tsconfig.json'
];

const ENTRY_POINT_DIRECTORIES: readonly string[] = ['src', 'app', 'cmd'];

/** Hard depth bound for the walk, independent of the file-count budget. */
const MAX_WALK_DEPTH = 6;

/**
 * Read only the small structured fields the snapshot needs from a manifest, and
 * never its body. An unknown or malformed manifest yields no fields rather than
 * the raw text.
 */
export function readManifestFields(path: string, text: string): Record<string, string> {
  const name = basename(path);
  const fields: Record<string, string> = {};
  try {
    if (name === 'package.json' || name === 'tsconfig.json') {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.name === 'string') {
        fields.name = parsed.name;
      }
      if (typeof parsed.version === 'string') {
        fields.version = parsed.version;
      }
      if (typeof parsed.description === 'string') {
        fields.description = parsed.description.slice(0, 200);
      }
      const scripts = parsed.scripts;
      if (scripts && typeof scripts === 'object') {
        fields.scripts = Object.keys(scripts as Record<string, unknown>).slice(0, 24).join(', ');
      }
      if (name === 'tsconfig.json' && typeof parsed.extends === 'string') {
        fields.extends = parsed.extends;
      }
    } else if (name === 'cargo.toml') {
      fields.name = firstMatch(text, /^\s*name\s*=\s*"([^"]+)"/m) ?? '';
      fields.version = firstMatch(text, /^\s*version\s*=\s*"([^"]+)"/m) ?? '';
      fields.edition = firstMatch(text, /^\s*edition\s*=\s*"([^"]+)"/m) ?? '';
    } else if (name === 'pyproject.toml') {
      fields.name = firstMatch(text, /^\s*name\s*=\s*"([^"]+)"/m) ?? '';
      fields.version = firstMatch(text, /^\s*version\s*=\s*"([^"]+)"/m) ?? '';
      fields.requiresPython = firstMatch(text, /^\s*requires-python\s*=\s*"([^"]+)"/m) ?? '';
    } else if (name === 'go.mod') {
      fields.module = firstMatch(text, /^\s*module\s+(\S+)/m) ?? '';
      fields.go = firstMatch(text, /^\s*go\s+(\S+)/m) ?? '';
    }
  } catch {
    // A malformed manifest is not a reason to fail the snapshot.
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value === '') {
      delete fields[key];
    }
  }
  return fields;
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match ? match[1] : undefined;
}

function joinPath(root: string, ...relative: string[]): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...relative].join(separator);
}

/**
 * The first remote url in a `.git/config` body, preferring `origin`. Pure so it
 * is testable without a host; the adapter reads the file and passes the body.
 */
export function remoteUrl(config: string): string | null {
  const blocks = config.split(/^\[remote\s+"([^"]+)"\]\s*$/m);
  // `split` with a capture yields [before, name, body, name, body, ...].
  const names: string[] = [];
  const bodies: string[] = [];
  for (let i = 1; i < blocks.length; i += 2) {
    names.push(blocks[i]);
    bodies.push(blocks[i + 1] ?? '');
  }
  const origin = names.indexOf('origin');
  const order =
    origin === -1 ? names.map((_, index) => index) : [origin, ...names.map((_, index) => index).filter((index) => index !== origin)];
  for (const index of order) {
    const match = /^\s*url\s*=\s*(.+)\s*$/m.exec(bodies[index]);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

/** `owner/repo` for a common git remote url, or the url itself when unknown. */
export function ownerRepo(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '');
  const match = /(?:[/:])([^/:]+\/[^/]+)$/.exec(cleaned);
  return match ? match[1] : cleaned;
}

/** A workspace-relative path, or `null` when the path is outside every root. */
function displayPath(absolute: string, roots: readonly string[]): string | null {
  const posix = toPosix(absolute);
  for (const root of roots) {
    const normalizedRoot = toPosix(root).replace(/\/+$/, '');
    if (posix.toLowerCase() === normalizedRoot.toLowerCase()) {
      return '';
    }
    if (posix.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) {
      return posix.slice(normalizedRoot.length + 1);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

interface RawShape {
  roots: readonly string[];
  filePaths: string[];
  tree: DirectoryNode[];
  manifests: ManifestHit[];
  totalFiles: number;
  scanTruncated: boolean;
}

interface RawEditor {
  state: EditorState;
  excludedPaths: ExcludedPath[];
}

/** Why the cached workspace picture is no longer valid. */
export type ContextInvalidation =
  | 'workspaceFolders'
  | 'fileCreated'
  | 'fileSaved'
  | 'fileDeleted'
  | 'gitBranch'
  | 'configuration';

export class ProjectContext implements ProjectContextReads {
  private readonly host: ProjectContextHost;
  /** Per-category caps that never change; the overall cap is settings-driven. */
  private readonly baseBudget: ContextBudget;
  /** The effective caps for the current settings, refreshed on every snapshot. */
  private budget: ContextBudget;
  /**
   * The workspace picture, keyed by the exact root list and ignore patterns it
   * was built for. The structural walk is cached; editor state and git identity
   * are re-read every snapshot because they are cheap and change constantly.
   */
  private shapeCache?: { key: string; raw: RawShape; excluded: ExcludedPath[] };
  /** The instruction-document scan, cached under the same key. */
  private instructionsCache?: { key: string; documents: InstructionDocument[] };

  constructor(options: ProjectSnapshotOptions) {
    this.host = options.host;
    this.baseBudget = options.budget ?? DEFAULT_BUDGET;
    this.budget = this.baseBudget;
  }

  /**
   * The settings screen defaults, or the documented defaults when the host
   * supplies none. The `reads` seam always answers (so the render path can read
   * `maxBytes`), while `settingsOrUndefined()` distinguishes "no settings" from
   * "documented defaults" for the budget, so an injected budget is respected.
   */
  contextSettings(): ContextSettings {
    return this.settingsOrUndefined() ?? DEFAULT_CONTEXT_SETTINGS;
  }

  private settingsOrUndefined(): ContextSettings | undefined {
    return this.host.contextSettings?.();
  }

  private settings(): ContextSettings {
    return this.contextSettings();
  }

  /**
   * Drop the cached workspace picture. Called by the host adapter on a
   * workspace-folder, file create/save/delete, git branch, or configuration
   * change. Typing only changes the selection, which is delta-only and never
   * routed here, so the tree is not rebuilt per keystroke.
   */
  invalidate(_reason: ContextInvalidation): void {
    this.shapeCache = undefined;
    this.instructionsCache = undefined;
  }

  /**
   * Build the full picture. The reads are performed once and assembled into
   * bounded categories; a category that is empty says so explicitly.
   */
  async getSnapshot(input: GetSnapshotInput = {}): Promise<ProjectSnapshot> {
    const hostSettings = this.settingsOrUndefined();
    const settings = hostSettings ?? DEFAULT_CONTEXT_SETTINGS;
    // The screen owns the overall cap; the per-category caps stay fixed. When
    // the host supplies no settings (a test with an injected budget), the
    // constructor budget is left in charge.
    this.budget = hostSettings ? { ...this.baseBudget, overall: settings.maxBytes } : this.baseBudget;

    const roots = this.host.workspaceRoots();
    const patterns = [...this.host.filesExclude(), ...this.host.searchExclude()];
    // `userExclude()` is the one read of `melink.context.exclude`; the settings
    // shape mirrors it for the settings screen, so it is not appended twice.
    const user = [...this.host.userExclude()];
    const globOptions: GlobOptions = { patterns, user, root: roots[0] };
    const excludedPaths: ExcludedPath[] = [];

    const workspace = await this.buildWorkspace(roots);
    const shape = settings.includeShape
      ? await this.buildShape(roots, globOptions, excludedPaths, input.changedPaths ?? [])
      : emptyShape(roots);
    const instructions = settings.includeInstructions
      ? await this.buildInstructions(roots, globOptions)
      : [];
    const editor = settings.includeEditorState
      ? await this.buildEditor(roots, globOptions, settings.includeSelection)
      : emptyEditor();
    excludedPaths.push(...editor.excludedPaths);

    const snapshot: ProjectSnapshot = {
      timestamp: this.host.now(),
      workspace: this.capIdentity(workspace),
      shape: this.capShape(shape),
      instructions: this.capInstructions(instructions),
      editor: this.capEditor(editor.state),
      exclusions: {
        directories: [...IGNORED_DIRECTORIES],
        patterns,
        user
      },
      excludedPaths: dedupeExcluded(excludedPaths),
      truncated: null
    };

    return this.enforceOverall(snapshot);
  }

  /**
   * What changed since `previous`. Returns an empty delta when nothing
   * meaningful changed, so a caller can skip rebuilding a prompt's context.
   */
  async getDelta(previous: ProjectSnapshot, current?: ProjectSnapshot): Promise<ProjectDelta> {
    const next = current ?? (await this.getSnapshot());
    const workspaceChanged =
      !sameStringArray(previous.workspace.roots, next.workspace.roots) ||
      previous.workspace.multiRoot !== next.workspace.multiRoot ||
      previous.workspace.isGitRepo !== next.workspace.isGitRepo ||
      previous.workspace.branch !== next.workspace.branch ||
      previous.workspace.remote !== next.workspace.remote;

    const activeChanged = !sameActive(previous.editor.active, next.editor.active);
    const selectionChanged =
      JSON.stringify(previous.editor.active?.selection ?? null) !==
      JSON.stringify(next.editor.active?.selection ?? null);
    const openChanged =
      JSON.stringify(previous.editor.openEditors) !== JSON.stringify(next.editor.openEditors);
    const dirtyChanged = !sameStringArray(previous.editor.dirtyFiles, next.editor.dirtyFiles);
    const terminalChanged = previous.editor.terminalCwd !== next.editor.terminalCwd;

    const previousFiles = collectFilePaths(previous);
    const nextFiles = collectFilePaths(next);
    const { added, removed } = diffSets(previousFiles, nextFiles);
    const filesChanged = added.length > 0 || removed.length > 0;

    const changed =
      workspaceChanged ||
      activeChanged ||
      selectionChanged ||
      openChanged ||
      dirtyChanged ||
      terminalChanged ||
      filesChanged;

    const delta: ProjectDelta = { changed };
    if (workspaceChanged) {
      delta.workspace = true;
      delta.gitBranch = previous.workspace.branch !== next.workspace.branch;
    }
    if (filesChanged && this.settings().includeChangedFiles) {
      delta.files = { added, removed };
    }
    if (activeChanged) {
      delta.activeEditor = true;
    }
    if (selectionChanged) {
      delta.selection = true;
    }
    if (openChanged) {
      delta.openEditors = true;
    }
    if (dirtyChanged) {
      delta.dirtyFiles = [...next.editor.dirtyFiles];
    }
    if (terminalChanged) {
      delta.terminalCwd = true;
    }
    return delta;
  }

  /* ------------------------------- identity -------------------------------- */

  private async buildWorkspace(roots: readonly string[]): Promise<WorkspaceIdentity> {
    const primary = roots[0];
    let branch: string | null = null;
    let remote: string | null = null;
    if (primary) {
      branch = await this.host.gitBranch(primary);
      remote = await this.host.gitRemote(primary);
    }
    return {
      names: roots.map((root) => basename(root) || root),
      roots: [...roots],
      multiRoot: roots.length > 1,
      isGitRepo: branch !== null || remote !== null,
      branch,
      remote,
      truncated: null
    };
  }

  /* ------------------------------- project shape --------------------------- */

  private async buildShape(
    roots: readonly string[],
    globOptions: GlobOptions,
    excludedPaths: ExcludedPath[],
    changedPaths: readonly string[]
  ): Promise<RawShape> {
    const key = JSON.stringify([roots, globOptions.patterns, globOptions.user]);
    let cached = this.shapeCache;
    if (!cached || cached.key !== key) {
      const filePaths: string[] = [];
      const tree: DirectoryNode[] = [];
      const walkExcluded: ExcludedPath[] = [];
      let totalFiles = 0;

      for (const root of roots) {
        const scanned = await this.walkDirectory(root, 0, roots, globOptions, filePaths, tree, walkExcluded);
        totalFiles += scanned;
        if (totalFiles >= this.budget.scanLimit) {
          break;
        }
      }

      const manifests = await this.detectManifests(roots, globOptions);
      const raw: RawShape = {
        roots,
        filePaths,
        tree,
        manifests,
        totalFiles,
        scanTruncated: filePaths.length >= this.budget.scanLimit
      };
      cached = { key, raw, excluded: walkExcluded };
      this.shapeCache = cached;
    }

    excludedPaths.push(...cached.excluded);
    // Event-sourced paths are never cached: they are the delta between the
    // cached walk and the current host state.
    const filePaths = [...cached.raw.filePaths];
    for (const changed of changedPaths) {
      const classified = this.classify(changed, roots, globOptions);
      if (classified.excluded) {
        excludedPaths.push({ path: changed, reason: classified.reason ?? 'excluded' });
      } else {
        filePaths.push(changed);
      }
    }
    return { ...cached.raw, filePaths };
  }

  /**
   * Walk one directory, skipping an excluded directory before descending into
   * it so a secret store or `node_modules` tree is never enumerated. Returns the
   * number of files seen. Directory nodes are recorded only for depth 1 and 2,
   * which is the bounded tree the snapshot describes; files are counted a little
   * deeper so the language breakdown reflects more than the tree does, but the
   * whole walk is bounded by `scanLimit` and a hard depth cap.
   */
  private async walkDirectory(
    directory: string,
    depth: number,
    roots: readonly string[],
    globOptions: GlobOptions,
    outFiles: string[],
    outTree: DirectoryNode[],
    excludedPaths: ExcludedPath[]
  ): Promise<number> {
    if (outFiles.length >= this.budget.scanLimit || depth > MAX_WALK_DEPTH) {
      return 0;
    }
    const entries = await this.host.listDirectory(directory);
    let count = 0;
    for (const entry of entries) {
      const classified = this.classify(entry.path, roots, globOptions);
      if (classified.excluded) {
        excludedPaths.push({ path: entry.path, reason: classified.reason ?? 'excluded' });
        continue;
      }
      if (entry.isDirectory) {
        if (depth < 2) {
          outTree.push({
            path: displayPath(entry.path, roots) ?? toPosix(entry.path),
            name: basename(entry.path),
            depth: depth + 1,
            entries: entries.length
          });
        }
        count += await this.walkDirectory(entry.path, depth + 1, roots, globOptions, outFiles, outTree, excludedPaths);
      } else {
        outFiles.push(entry.path);
        count += 1;
      }
      if (outFiles.length >= this.budget.scanLimit) {
        break;
      }
    }
    return count;
  }

  private async detectManifests(roots: readonly string[], globOptions: GlobOptions): Promise<ManifestHit[]> {
    const hits: ManifestHit[] = [];
    for (const root of roots) {
      const rootOptions: GlobOptions = { ...globOptions, root };
      for (const name of MANIFEST_KINDS) {
        const path = joinPath(root, name);
        const classified = classifyPath(path, rootOptions);
        if (classified.excluded) {
          continue;
        }
        const text = await this.host.readFile(path);
        if (text === undefined) {
          continue;
        }
        hits.push({
          path: displayPath(path, roots) ?? toPosix(path),
          kind: name,
          fields: readManifestFields(path, text)
        });
      }
      for (const directory of ENTRY_POINT_DIRECTORIES) {
        const path = joinPath(root, directory);
        const entries = await this.host.listDirectory(path).catch(() => [] as DirectoryEntry[]);
        if (entries.length > 0) {
          hits.push({ path: `${displayPath(path, roots) ?? directory}/`, kind: `${directory}/` });
        }
      }
    }
    return hits;
  }

  /* ------------------------------- instructions ---------------------------- */

  private async buildInstructions(roots: readonly string[], globOptions: GlobOptions): Promise<InstructionDocument[]> {
    const key = JSON.stringify([roots, globOptions.patterns, globOptions.user]);
    const cached = this.instructionsCache;
    if (cached && cached.key === key) {
      return cached.documents;
    }
    const documents: InstructionDocument[] = [];
    const candidates: { path: string; kind: string }[] = [];

    for (const root of roots) {
      candidates.push({ path: joinPath(root, 'AGENTS.md'), kind: 'agents' });
      candidates.push({ path: joinPath(root, 'README.md'), kind: 'readme' });
      candidates.push({ path: joinPath(root, '.github', 'copilot-instructions.md'), kind: 'copilot' });
      for (const nested of await this.nestedAgents(root, globOptions)) {
        candidates.push({ path: nested, kind: 'agents' });
      }
    }

    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (documents.length >= this.budget.documentEntries) {
        break;
      }
      const candidateKey = candidate.path.toLowerCase();
      if (seen.has(candidateKey)) {
        continue;
      }
      seen.add(candidateKey);
      const classified = classifyPath(candidate.path, globOptions);
      // An instruction document is explicitly requested, so a glob match alone
      // does not refuse it. Secret stores and key material always refuse it.
      if (classified.excluded && (classified.reason === 'secret' || classified.reason === 'key-material')) {
        continue;
      }
      const text = await this.host.readFile(candidate.path);
      if (text === undefined) {
        continue;
      }
      const bounded = excerptOf(text, this.budget.excerptBytes);
      documents.push({
        path: displayPath(candidate.path, roots) ?? toPosix(candidate.path),
        kind: candidate.kind,
        excerpt: bounded.text,
        truncated: bounded.truncated
      });
    }
    this.instructionsCache = { key, documents };
    return documents;
  }

  /** Nested `AGENTS.md` files, bounded by depth, pruning excluded directories. */
  private async nestedAgents(root: string, globOptions: GlobOptions): Promise<string[]> {
    const found: string[] = [];
    const maxDepth = this.budget.instructionDepth;
    const rootOptions: GlobOptions = { ...globOptions, root };
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && found.length < this.budget.documentEntries) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) {
        continue;
      }
      const entries = await this.host.listDirectory(current.dir).catch(() => [] as DirectoryEntry[]);
      for (const entry of entries) {
        const classified = classifyPath(entry.path, rootOptions);
        if (classified.excluded && classified.reason !== 'excluded') {
          continue;
        }
        if (entry.isDirectory) {
          queue.push({ dir: entry.path, depth: current.depth + 1 });
        } else if (basename(entry.path) === 'agents.md' && entry.path !== joinPath(root, 'AGENTS.md')) {
          found.push(entry.path);
        }
      }
    }
    return found;
  }

  /* ------------------------------- editor state ---------------------------- */

  private async buildEditor(
    roots: readonly string[],
    globOptions: GlobOptions,
    includeSelection: boolean
  ): Promise<RawEditor> {
    const excludedPaths: ExcludedPath[] = [];
    const active = this.host.activeEditor();
    const openEditors = this.host.openEditors();
    const dirty = this.host.dirtyFiles();
    const terminalCwd = this.host.terminalCwd ? await this.host.terminalCwd() : null;

    let activeState: ActiveEditorState | null = null;
    if (active) {
      const classified = this.classify(active.absolutePath, roots, globOptions);
      if (classified.excluded) {
        excludedPaths.push({ path: active.absolutePath, reason: classified.reason ?? 'excluded' });
      }
      // The selection is reported as excluded rather than quoted. The text is
      // read through a separate host call that is only made when the file is
      // not excluded, so a secret is never read at all.
      // The selected text is only read when the user shares selections, so with
      // selection sharing off no selection content is ever read at all.
      const selection =
        includeSelection && active.selection && !classified.excluded
          ? this.boundSelection(active.selection, this.host.activeSelectionText())
          : null;
      activeState = {
        absolutePath: active.absolutePath,
        relativePath: displayPath(active.absolutePath, roots),
        languageId: active.languageId,
        selection,
        excluded: classified.excluded,
        ...(classified.reason ? { exclusionReason: classified.reason } : {})
      };
    }

    const editorList: OpenEditor[] = [];
    for (const editor of openEditors) {
      const classified = this.classify(editor.absolutePath, roots, globOptions);
      if (classified.excluded) {
        excludedPaths.push({ path: editor.absolutePath, reason: classified.reason ?? 'excluded' });
      }
      editorList.push({
        absolutePath: editor.absolutePath,
        relativePath: displayPath(editor.absolutePath, roots),
        languageId: editor.languageId,
        isActive: editor.isActive,
        isDirty: editor.isDirty
      });
    }

    for (const path of dirty) {
      const classified = this.classify(path, roots, globOptions);
      if (classified.excluded) {
        excludedPaths.push({ path, reason: classified.reason ?? 'excluded' });
      }
    }

    return {
      state: {
        active: activeState,
        openEditors: editorList,
        dirtyFiles: dirty.map((path) => displayPath(path, roots) ?? path),
        terminalCwd,
        truncated: null
      },
      excludedPaths
    };
  }

  /**
   * The file the user is viewing, for an explicit attach. A secret or other
   * excluded path is reported and never read.
   */
  async viewedFileAttachment(): Promise<ViewedFileAttachment | undefined> {
    const active = this.host.activeEditor();
    if (!active) {
      return undefined;
    }
    const roots = this.host.workspaceRoots();
    const globOptions: GlobOptions = {
      patterns: [...this.host.filesExclude(), ...this.host.searchExclude()],
      user: [...this.host.userExclude()],
      root: roots[0]
    };
    const classified = this.classify(active.absolutePath, roots, globOptions);
    const path = displayPath(active.absolutePath, roots) ?? active.absolutePath;
    if (classified.excluded) {
      return {
        path,
        languageId: active.languageId,
        excluded: true,
        ...(classified.reason ? { exclusionReason: classified.reason } : {})
      };
    }
    const raw = this.host.activeFileText?.() ?? (await this.host.readFile(active.absolutePath)) ?? '';
    const bounded = cutToBytes(raw, ATTACHED_FILE_BYTES);
    let selection: string | undefined;
    if (active.selection && this.settings().includeSelection) {
      const selected = cutToBytes(this.host.activeSelectionText(), this.budget.excerptBytes);
      if (selected.text.length > 0) {
        selection = selected.text;
      }
    }
    return {
      path,
      languageId: active.languageId,
      excluded: false,
      text: bounded.text,
      truncated: bounded.truncated,
      ...(selection ? { selection } : {})
    };
  }

  /** Classify a path against the workspace root it actually belongs to. */
  private classify(
    path: string,
    roots: readonly string[],
    globOptions: GlobOptions
  ): { excluded: boolean; reason?: ExclusionReason } {
    const posix = toPosix(path);
    const root = roots.find((candidate) => {
      const normalized = toPosix(candidate).replace(/\/+$/, '').toLowerCase();
      return posix.toLowerCase() === normalized || posix.toLowerCase().startsWith(`${normalized}/`);
    });
    return classifyPath(path, { ...globOptions, root: root ?? roots[0] });
  }

  private boundSelection(
    selection: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    },
    text: string
  ): EditorSelection {
    const bounded = cutToBytes(text, this.budget.excerptBytes);
    return {
      startLine: selection.startLine,
      startColumn: selection.startColumn,
      endLine: selection.endLine,
      endColumn: selection.endColumn,
      text: bounded.text.length > 0 ? bounded.text : null,
      truncated: bounded.truncated
    };
  }

  /* ------------------------------- caps ------------------------------------ */

  /** Identity is tiny; if it ever exceeds its cap, drop the display names. */
  private capIdentity(workspace: WorkspaceIdentity): WorkspaceIdentity {
    if (jsonBytes(workspace) <= this.budget.identity) {
      return workspace;
    }
    const reduced: WorkspaceIdentity = {
      ...workspace,
      names: [],
      truncated: markerJoin(workspace.truncated, truncationMarker(0, workspace.names.length))
    };
    return jsonBytes(reduced) <= this.budget.identity ? reduced : { ...reduced, branch: null, remote: null };
  }

  private capShape(raw: RawShape): ProjectShape {
    const allLanguages = countLanguages(raw.filePaths);
    const treeTotal = raw.tree.length;
    const manifestTotal = raw.manifests.length;
    const languageTotal = allLanguages.length;

    const markers: string[] = [];
    let tree = raw.tree.slice(0, this.budget.treeEntries);
    let languages = allLanguages.slice(0, this.budget.languageEntries);
    let manifests = raw.manifests.slice(0, this.budget.treeEntries);

    const allFiles = [...new Set(raw.filePaths.map((path) => displayPath(path, raw.roots) ?? toPosix(path)))].sort();
    const files = allFiles.slice(0, this.budget.fileEntries);
    if (files.length < allFiles.length) {
      markers.push(truncationMarker(files.length, allFiles.length));
    }
    if (tree.length < treeTotal) {
      markers.push(truncationMarker(tree.length, treeTotal));
    }
    if (languages.length < languageTotal) {
      markers.push(truncationMarker(languages.length, languageTotal));
    }
    if (manifests.length < manifestTotal) {
      markers.push(truncationMarker(manifests.length, manifestTotal));
    }
    if (raw.scanTruncated) {
      markers.push(truncationMarker(this.budget.scanLimit, raw.totalFiles));
    }

    let shape: ProjectShape = {
      languages,
      tree,
      manifests,
      files,
      totalFiles: raw.totalFiles,
      languagesTruncated: languages.length < languageTotal,
      truncated: markers.length > 0 ? markers.join('; ') : null
    };

    while (jsonBytes(shape) > this.budget.shape && shape.tree.length > 0) {
      shape = { ...shape, tree: shape.tree.slice(0, Math.floor(shape.tree.length / 2)) };
      shape.truncated = markerJoin(shape.truncated, truncationMarker(shape.tree.length, treeTotal));
    }
    while (jsonBytes(shape) > this.budget.shape && shape.languages.length > 0) {
      shape = { ...shape, languages: shape.languages.slice(0, Math.floor(shape.languages.length / 2)) };
      shape.languagesTruncated = true;
      shape.truncated = markerJoin(shape.truncated, truncationMarker(shape.languages.length, languageTotal));
    }
    while (jsonBytes(shape) > this.budget.shape && shape.manifests.length > 0) {
      shape = { ...shape, manifests: shape.manifests.slice(0, Math.floor(shape.manifests.length / 2)) };
      shape.truncated = markerJoin(shape.truncated, truncationMarker(shape.manifests.length, manifestTotal));
    }
    while (jsonBytes(shape) > this.budget.shape && shape.files.length > 0) {
      shape = { ...shape, files: shape.files.slice(0, Math.floor(shape.files.length / 2)) };
      shape.truncated = markerJoin(shape.truncated, truncationMarker(shape.files.length, allFiles.length));
    }
    if (jsonBytes(shape) > this.budget.shape) {
      shape = { ...shape, languages: [], tree: [], manifests: [], files: [] };
    }
    return shape;
  }

  private capInstructions(documents: readonly InstructionDocument[]): InstructionDocs {
    const sorted = [...documents].sort((a, b) => a.path.localeCompare(b.path));
    const total = sorted.length;
    let selected = sorted.slice(0, this.budget.documentEntries);
    let truncated: string | null =
      selected.length < total ? truncationMarker(selected.length, total) : null;

    // Enforce both the per-document excerpt cap and the category byte cap.
    let docs = selected.map((document) => {
      const bounded = cutToBytes(document.excerpt, this.budget.excerptBytes);
      return { ...document, excerpt: bounded.text, truncated: document.truncated || bounded.truncated };
    });

    while (jsonBytes({ documents: docs }) > this.budget.instructions && docs.length > 0) {
      docs = docs.slice(0, Math.floor(docs.length / 2));
      truncated = markerJoin(truncated, truncationMarker(docs.length, total));
    }
    if (jsonBytes({ documents: docs }) > this.budget.instructions) {
      docs = [];
    }

    const noneFound = docs.length === 0;
    return { documents: docs, noneFound, truncated: noneFound ? null : truncated };
  }

  private capEditor(editor: EditorState): EditorState {
    const total = editor.openEditors.length;
    let state: EditorState = {
      ...editor,
      openEditors: editor.openEditors.slice(0, this.budget.editorEntries),
      truncated: total > Math.min(total, this.budget.editorEntries)
        ? truncationMarker(Math.min(total, this.budget.editorEntries), total)
        : null
    };

    while (jsonBytes(state) > this.budget.editor && state.openEditors.length > 0) {
      state = { ...state, openEditors: state.openEditors.slice(0, Math.floor(state.openEditors.length / 2)) };
      state.truncated = markerJoin(state.truncated, truncationMarker(state.openEditors.length, total));
    }
    while (jsonBytes(state) > this.budget.editor && state.dirtyFiles.length > 0) {
      state = { ...state, dirtyFiles: state.dirtyFiles.slice(0, Math.floor(state.dirtyFiles.length / 2)) };
    }
    // The active editor's identity is never dropped; only its selection text is.
    const active = state.active;
    if (jsonBytes(state) > this.budget.editor && active?.selection?.text) {
      state = {
        ...state,
        active: { ...active, selection: { ...active.selection, text: null, truncated: true } },
        truncated: markerJoin(state.truncated, truncationMarker(0, 1))
      };
    }
    return state;
  }

  /**
   * Enforce the overall cap by dropping the reconstructible parts first: the
   * open-editor list, then instruction documents, then the tree. The active
   * editor, its selection range, identity and manifests survive as long as
   * possible, and every drop is marked.
   */
  private enforceOverall(snapshot: ProjectSnapshot): ProjectSnapshot {
    if (jsonBytes(snapshot) <= this.budget.overall) {
      return snapshot;
    }
    let result = snapshot;
    let overall = result.truncated;

    // Every mark is attached to `result` immediately, so the byte checks below
    // account for the marker text that will actually ship in the snapshot.
    const mark = (marker: string): void => {
      overall = markerJoin(overall, marker);
      result = { ...result, truncated: overall };
    };

    if (result.editor.openEditors.length > 0) {
      mark(truncationMarker(0, result.editor.openEditors.length));
      result = {
        ...result,
        editor: {
          ...result.editor,
          openEditors: [],
          truncated: markerJoin(result.editor.truncated, truncationMarker(0, snapshot.editor.openEditors.length))
        }
      };
    }
    if (jsonBytes(result) > this.budget.overall && result.instructions.documents.length > 0) {
      mark(truncationMarker(0, result.instructions.documents.length));
      result = {
        ...result,
        instructions: { documents: [], noneFound: false, truncated: truncationMarker(0, snapshot.instructions.documents.length) }
      };
    }
    // Shape lists shrink in lockstep: tree, files, languages, manifests.
    while (jsonBytes(result) > this.budget.overall && result.shape.tree.length > 0) {
      const before = result.shape.tree.length;
      result = { ...result, shape: { ...result.shape, tree: result.shape.tree.slice(0, Math.floor(before / 2)) } };
      result.shape.truncated = markerJoin(result.shape.truncated, truncationMarker(result.shape.tree.length, before));
    }
    while (jsonBytes(result) > this.budget.overall && result.shape.files.length > 0) {
      const before = result.shape.files.length;
      result = { ...result, shape: { ...result.shape, files: result.shape.files.slice(0, Math.floor(before / 2)) } };
      result.shape.truncated = markerJoin(result.shape.truncated, truncationMarker(result.shape.files.length, before));
    }
    while (jsonBytes(result) > this.budget.overall && result.shape.languages.length > 0) {
      const before = result.shape.languages.length;
      result = { ...result, shape: { ...result.shape, languages: result.shape.languages.slice(0, Math.floor(before / 2)) } };
      result.shape.truncated = markerJoin(result.shape.truncated, truncationMarker(result.shape.languages.length, before));
    }
    while (jsonBytes(result) > this.budget.overall && result.shape.manifests.length > 0) {
      const before = result.shape.manifests.length;
      result = { ...result, shape: { ...result.shape, manifests: result.shape.manifests.slice(0, Math.floor(before / 2)) } };
      result.shape.truncated = markerJoin(result.shape.truncated, truncationMarker(result.shape.manifests.length, before));
    }
    // The selection text is the last editor detail that can go; the range stays.
    const active = result.editor.active;
    const selection = active?.selection;
    if (jsonBytes(result) > this.budget.overall && selection && selection.text) {
      result = {
        ...result,
        editor: {
          ...result.editor,
          active: { ...(active as ActiveEditorState), selection: { ...selection, text: null, truncated: true } }
        }
      };
    }
    // Excluded-path metadata is diagnostic, not the picture: when it alone
    // keeps the snapshot over, it is trimmed before anything meaningful is.
    while (jsonBytes(result) > this.budget.overall && result.excludedPaths.length > 0) {
      result = { ...result, excludedPaths: result.excludedPaths.slice(0, Math.floor(result.excludedPaths.length / 2)) };
      mark(truncationMarker(0, snapshot.excludedPaths.length));
    }
    if (jsonBytes(result) > this.budget.overall) {
      mark(truncationMarker(0, 1));
      result = {
        ...result,
        shape: {
          languages: [],
          tree: [],
          manifests: [],
          files: [],
          totalFiles: 0,
          languagesTruncated: false,
          truncated: truncationMarker(0, 1)
        },
        instructions: { documents: [], noneFound: true, truncated: null },
        excludedPaths: [],
        editor: { ...result.editor, dirtyFiles: [] }
      };
    }
    return { ...result, truncated: overall };
  }
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A shape with nothing collected, used when the user turns project shape off.
 * It is a valid, explicitly-empty category rather than an absent one, so the
 * renderer still says "none" instead of failing.
 */
function emptyShape(roots: readonly string[]): RawShape {
  return {
    roots,
    filePaths: [],
    tree: [],
    manifests: [],
    totalFiles: 0,
    scanTruncated: false
  };
}

/** Editor state with every read suppressed, used when auto-attach is off. */
function emptyEditor(): RawEditor {
  return {
    state: {
      active: null,
      openEditors: [],
      dirtyFiles: [],
      terminalCwd: null,
      truncated: null
    },
    excludedPaths: []
  };
}

function countLanguages(filePaths: readonly string[]): LanguageCount[] {
  const counts = new Map<string, number>();
  for (const path of filePaths) {
    const language = languageForPath(path);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language));
}

function collectFilePaths(snapshot: ProjectSnapshot): string[] {
  const paths = new Set<string>(snapshot.shape.files);
  for (const manifest of snapshot.shape.manifests) {
    paths.add(manifest.path);
  }
  for (const node of snapshot.shape.tree) {
    if (node.path) {
      paths.add(node.path);
    }
  }
  for (const editor of snapshot.editor.openEditors) {
    paths.add(editor.relativePath ?? editor.absolutePath);
  }
  if (snapshot.editor.active) {
    paths.add(snapshot.editor.active.relativePath ?? snapshot.editor.active.absolutePath);
  }
  for (const dirty of snapshot.editor.dirtyFiles) {
    paths.add(dirty);
  }
  return [...paths];
}

function diffSets(previous: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
  const before = new Set(previous);
  const after = new Set(next);
  const added = next.filter((entry) => !before.has(entry)).sort();
  const removed = previous.filter((entry) => !after.has(entry)).sort();
  return { added, removed };
}

function sameActive(a: ActiveEditorState | null, b: ActiveEditorState | null): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return a.absolutePath === b.absolutePath && a.languageId === b.languageId && a.excluded === b.excluded;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function dedupeExcluded(paths: readonly ExcludedPath[]): ExcludedPath[] {
  const seen = new Set<string>();
  const result: ExcludedPath[] = [];
  for (const entry of paths) {
    const key = `${entry.path}\u0000${entry.reason}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}
