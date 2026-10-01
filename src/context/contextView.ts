/**
 * The project-context read model the composer renders.
 *
 * The snapshot service owns the workspace picture and the renderer owns the
 * wording sent to a model. This module is the third, small piece: it turns one
 * `ProjectSnapshot` into a bounded, legible view the composer strip and its
 * inline inspect panel render, and it applies a per-turn exclusion set to the
 * snapshot the delivery layer will send.
 *
 * It is host-free: it imports the snapshot and settings types only, so
 * `npm test` can drive it with a fake snapshot. Nothing here recomputes context
 * the webview could not see: every field is derived from the same snapshot the
 * next turn is built from.
 */

import type { ContextSettings } from './contextSettings.ts';
import type {
  ActiveEditorState,
  EditorState,
  ExclusionReason,
  InstructionDocument,
  OpenEditor,
  ProjectShape,
  ProjectSnapshot
} from './projectContext.ts';

/** The five categories the panel lists, in the order it lists them. */
export type ContextCategoryId = 'instructions' | 'shape' | 'editor' | 'selection' | 'changedFiles';

/** Lifecycle the strip colours itself by. Failed is never shown as empty. */
export type ContextStatus = 'ready' | 'building' | 'empty' | 'failed';

export const CONTEXT_CATEGORY_ORDER: readonly ContextCategoryId[] = [
  'instructions',
  'shape',
  'editor',
  'selection',
  'changedFiles'
];

export const CONTEXT_CATEGORY_LABELS: Record<ContextCategoryId, string> = {
  instructions: 'Instructions',
  shape: 'Project shape',
  editor: 'Editor state',
  selection: 'Selection',
  changedFiles: 'Changed files'
};

/** One row inside a category: a path or label, an optional count, and the text. */
export interface ContextItemView {
  id: string;
  label: string;
  meta?: string;
  /** The exact text that will be sent for this entry, bounded. */
  excerpt?: string;
  /** True when this item is turned off for the next turn. */
  excluded: boolean;
  /** Plain-language reason, shown instead of a silently blank row. */
  reason?: string;
}

export interface ContextCategoryView {
  id: ContextCategoryId;
  label: string;
  /** Entries in the category, before any per-turn exclusion. */
  count: number;
  truncated: boolean;
  truncationNote?: string;
  /** True when the whole category is turned off for the next turn. */
  excluded: boolean;
  items: ContextItemView[];
}

/** The whole strip + panel read model, built by the host and rendered as-is. */
export interface ContextView {
  status: ContextStatus;
  workspaceName?: string;
  branch?: string;
  /** Workspace-relative path of the active file, shown in the strip. */
  activeFile?: string;
  /** Absolute path of the active file, for the open-in-editor affordance. */
  activeFilePath?: string;
  /** Lines in the current selection; 0 when there is none. */
  selectionLines: number;
  categories: ContextCategoryView[];
  /** Items that will actually be sent on the next turn. */
  includedCount: number;
  /** Items turned off for the next turn. */
  excludedCount: number;
  /** Categories still being sent, beyond the file and selection named in the strip. */
  remainingGroups: number;
  /** Plain-language line for the building, empty, and failed states. */
  message?: string;
}

/** The exclusion key for a whole category. */
export function categoryExclusionKey(id: ContextCategoryId): string {
  return `category:${id}`;
}

/** The exclusion key for one item inside a category. */
export function itemExclusionKey(id: ContextCategoryId, itemId: string): string {
  return `item:${id}:${itemId}`;
}

const REASON_LABELS: Record<ExclusionReason, string> = {
  secret: 'it looks like a secret store, so it is never read',
  'key-material': 'it looks like key material, so it is never read',
  dependency: 'it is a dependency directory',
  vcs: 'it is version-control metadata',
  build: 'it is build output',
  binary: 'it is a binary file',
  lockfile: 'it is a lockfile',
  excluded: 'it matches an exclude pattern',
  user: 'it matches your exclude list'
};

/** A plain-language reason for an excluded path, never a raw enum. */
export function exclusionReasonLabel(reason: ExclusionReason | undefined): string {
  return reason ? REASON_LABELS[reason] : 'it is excluded';
}

/** Exclusions may arrive as a set or an array; both read the same. */
function has(exclusions: ReadonlySet<string> | readonly string[], key: string): boolean {
  return toSet(exclusions).has(key);
}

/** Normalise a set or array of exclusion keys to a set. */
function toSet(exclusions: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return exclusions instanceof Set ? exclusions : new Set(exclusions);
}

/** Number of non-empty lines in an excerpt, for a compact count. */
function lineCount(text: string): number {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.length;
}

/* -------------------------------------------------------------------------- */
/* Building the view                                                          */
/* -------------------------------------------------------------------------- */

const EMPTY_SHAPE: ProjectShape = {
  languages: [],
  tree: [],
  manifests: [],
  files: [],
  totalFiles: 0,
  languagesTruncated: false,
  truncated: null
};

const EMPTY_EDITOR: EditorState = {
  active: null,
  openEditors: [],
  dirtyFiles: [],
  terminalCwd: null,
  truncated: null
};

function instructionItem(doc: InstructionDocument, excluded: boolean): ContextItemView {
  return {
    id: doc.path,
    label: doc.path,
    meta: doc.truncated ? 'truncated' : `${lineCount(doc.excerpt)} lines`,
    excerpt: doc.excerpt,
    excluded
  };
}

function shapeItem(shape: ProjectShape, excluded: boolean): ContextItemView {
  const files = shape.files.slice(0, 12);
  const more = Math.max(0, shape.files.length - files.length);
  const excerptLines = [...files, more > 0 ? `… ${more} more` : undefined]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  const excerpt = excerptLines.length > 0 ? excerptLines : 'No file paths were described.';
  return {
    id: 'tree',
    label: 'Workspace tree',
    meta: `${shape.totalFiles} files`,
    excerpt,
    excluded
  };
}

function editorItem(active: ActiveEditorState, excluded: boolean): ContextItemView {
  const label = active.relativePath ?? active.absolutePath;
  if (active.excluded) {
    return {
      id: 'active',
      label,
      meta: 'excluded',
      excluded: true,
      reason: `The active file is excluded because ${exclusionReasonLabel(active.exclusionReason)}.`
    };
  }
  return {
    id: 'active',
    label,
    meta: 'active file',
    excerpt: `${label} (${active.languageId})`,
    excluded
  };
}

function openEditorItem(editor: OpenEditor, excluded: boolean): ContextItemView {
  const label = editor.relativePath ?? editor.absolutePath;
  return {
    id: `open:${label}`,
    label,
    meta: editor.isDirty ? 'unsaved' : editor.isActive ? 'active' : 'open',
    excerpt: `${label}${editor.isDirty ? ' (unsaved)' : ''}`,
    excluded
  };
}

function changedFileItem(path: string, excluded: boolean): ContextItemView {
  return {
    id: `dirty:${path}`,
    label: path,
    meta: 'unsaved',
    excerpt: path,
    excluded
  };
}

function selectionItem(active: ActiveEditorState | null, excluded: boolean): ContextItemView | undefined {
  if (!active || !active.selection) {
    return undefined;
  }
  const { selection } = active;
  const label = `${active.relativePath ?? active.absolutePath} · lines ${selection.startLine}-${selection.endLine}`;
  if (active.excluded) {
    return {
      id: 'selection',
      label,
      meta: 'excluded',
      excluded: true,
      reason: `The selection is not quoted because ${exclusionReasonLabel(active.exclusionReason)}.`
    };
  }
  return {
    id: 'selection',
    label,
    meta: `${selection.endLine - selection.startLine + 1} lines`,
    excerpt: selection.text ?? '(selection text was not read)',
    excluded
  };
}

function category(params: {
  id: ContextCategoryId;
  items: ContextItemView[];
  excludedByCategory: boolean;
  truncated: boolean;
  truncationNote?: string;
}): ContextCategoryView {
  return {
    id: params.id,
    label: CONTEXT_CATEGORY_LABELS[params.id],
    count: params.items.length,
    truncated: params.truncated,
    ...(params.truncationNote ? { truncationNote: params.truncationNote } : {}),
    excluded: params.excludedByCategory,
    // A category turned off for the turn marks every row excluded, so the panel
    // shows the reduced set rather than silently dropping the rows.
    items: params.excludedByCategory
      ? params.items.map((item) => ({ ...item, excluded: true }))
      : params.items
  };
}

export interface BuildContextViewOptions {
  /** Per-turn exclusion keys, as produced by the exclusion key helpers. */
  exclusions?: ReadonlySet<string> | readonly string[];
  /** True while a refresh is in flight, so the strip says it is building. */
  building?: boolean;
}

/**
 * Turn one snapshot into the strip + panel read model.
 *
 * An excluded item stays visible in the panel marked excluded with its reason,
 * so a turned-off file is never a blank row, and the strip's counts reflect only
 * what is actually sent.
 */
export function buildContextView(
  snapshot: ProjectSnapshot,
  options: BuildContextViewOptions = {}
): ContextView {
  const exclusions = options.exclusions ?? [];
  const roots = snapshot.workspace.roots;
  const active = snapshot.editor?.active ?? null;
  const editor: EditorState = snapshot.editor ?? EMPTY_EDITOR;
  const shape: ProjectShape = snapshot.shape ?? EMPTY_SHAPE;

  if (roots.length === 0) {
    return {
      status: 'empty',
      selectionLines: 0,
      categories: [],
      includedCount: 0,
      excludedCount: 0,
      remainingGroups: 0,
      message: 'No folder is open, so there is no project context to send.'
    };
  }

  const excludedIn = (categoryId: ContextCategoryId, itemId: string): boolean =>
    has(exclusions, categoryExclusionKey(categoryId)) ||
    has(exclusions, itemExclusionKey(categoryId, itemId));

  const instructionsExcluded = has(exclusions, categoryExclusionKey('instructions'));
  const instructionItems = snapshot.instructions.documents.map((doc) =>
    instructionItem(doc, excludedIn('instructions', doc.path))
  );

  const shapeExcluded = has(exclusions, categoryExclusionKey('shape'));
  const shapeItems =
    shape.tree.length > 0 || shape.files.length > 0
      ? [shapeItem(shape, excludedIn('shape', 'tree'))]
      : [];

  const editorExcluded = has(exclusions, categoryExclusionKey('editor'));
  const activeItemExcluded = editorExcluded || has(exclusions, itemExclusionKey('editor', 'active'));
  // The selection is nested inside editor state, so an editor exclusion removes
  // it from what is sent as well; the view must say so rather than showing a
  // selection the next turn would not carry.
  const selectionExcluded =
    editorExcluded || activeItemExcluded || has(exclusions, categoryExclusionKey('selection'));
  const editorItems: ContextItemView[] = [];
  if (active) {
    editorItems.push(editorItem(active, excludedIn('editor', 'active')));
  }
  const activeLabel = active ? active.relativePath ?? active.absolutePath : undefined;
  for (const open of editor.openEditors) {
    const label = open.relativePath ?? open.absolutePath;
    if (activeLabel !== undefined && label === activeLabel) {
      continue;
    }
    editorItems.push(openEditorItem(open, excludedIn('editor', `open:${label}`)));
  }

  const selection = selectionItem(
    active,
    selectionExcluded || has(exclusions, itemExclusionKey('selection', 'selection'))
  );
  const selectionItems = selection ? [selection] : [];

  const changedFilesExcluded = has(exclusions, categoryExclusionKey('changedFiles'));
  const changedItems = editor.dirtyFiles.map((path) =>
    changedFileItem(path, excludedIn('changedFiles', `dirty:${path}`))
  );

  const categories: ContextCategoryView[] = [
    category({
      id: 'instructions',
      items: instructionItems,
      excludedByCategory: instructionsExcluded,
      truncated:
        snapshot.instructions.truncated !== null ||
        instructionItems.some((item) => item.meta === 'truncated'),
      ...(snapshot.instructions.truncated ? { truncationNote: snapshot.instructions.truncated } : {})
    }),
    category({
      id: 'shape',
      items: shapeItems,
      excludedByCategory: shapeExcluded,
      truncated: shape.truncated !== null,
      ...(shape.truncated ? { truncationNote: shape.truncated } : {})
    }),
    category({
      id: 'editor',
      items: editorItems,
      excludedByCategory: editorExcluded,
      truncated: editor.truncated !== null,
      ...(editor.truncated ? { truncationNote: editor.truncated } : {})
    }),
    category({
      id: 'selection',
      items: selectionItems,
      excludedByCategory: selectionExcluded,
      truncated: Boolean(active?.selection?.truncated)
    }),
    category({
      id: 'changedFiles',
      items: changedItems,
      excludedByCategory: changedFilesExcluded,
      truncated: false
    })
  ];

  // The strip names the active file and selection directly, so the summary chip
  // counts the remaining categories that still have something to send.
  const remainingGroups = categories.filter(
    (entry) =>
      entry.id !== 'editor' &&
      entry.id !== 'selection' &&
      !entry.excluded &&
      entry.items.some((item) => !item.excluded)
  ).length;

  const includedCount = categories.reduce(
    (sum, entry) => sum + entry.items.filter((item) => !item.excluded).length,
    0
  );
  const excludedCount = categories.reduce(
    (sum, entry) => sum + entry.items.filter((item) => item.excluded).length,
    0
  );

  // The strip names only what is actually sent. A per-turn exclusion on the
  // active file or the selection must remove it from the strip as well as from
  // the panel, so the strip reflects the reduced set.
  const activeFilePath = active && !activeItemExcluded ? active.absolutePath : undefined;
  const activeFile = active && !activeItemExcluded ? active.relativePath ?? active.absolutePath : undefined;
  const selectionLines =
    active?.selection && !active.excluded && !selectionExcluded
      ? active.selection.endLine - active.selection.startLine + 1
      : 0;

  return {
    status: options.building ? 'building' : 'ready',
    workspaceName: snapshot.workspace.names[0] ?? roots[0],
    ...(snapshot.workspace.branch ? { branch: snapshot.workspace.branch } : {}),
    ...(activeFile ? { activeFile } : {}),
    ...(activeFilePath ? { activeFilePath } : {}),
    selectionLines,
    categories,
    includedCount,
    excludedCount,
    remainingGroups
  };
}

/* -------------------------------------------------------------------------- */
/* Applying exclusions to the snapshot that is sent                           */
/* -------------------------------------------------------------------------- */

function keepItem(
  exclusions: ReadonlySet<string> | readonly string[],
  categoryId: ContextCategoryId,
  itemId: string
): boolean {
  return (
    !has(exclusions, categoryExclusionKey(categoryId)) &&
    !has(exclusions, itemExclusionKey(categoryId, itemId))
  );
}

function filterEditor(
  editor: EditorState,
  exclusions: ReadonlySet<string> | readonly string[]
): EditorState {
  const categoryOff = has(exclusions, categoryExclusionKey('editor'));
  const keepActive = !categoryOff && keepItem(exclusions, 'editor', 'active');
  const openEditors = categoryOff
    ? []
    : editor.openEditors.filter((open) =>
        keepItem(exclusions, 'editor', `open:${open.relativePath ?? open.absolutePath}`)
      );
  const dirtyOff = has(exclusions, categoryExclusionKey('changedFiles'));
  const dirtyFiles = dirtyOff
    ? []
    : editor.dirtyFiles.filter((path) => keepItem(exclusions, 'changedFiles', `dirty:${path}`));
  const selectionOff = !keepItem(exclusions, 'selection', 'selection');
  const active = keepActive ? editor.active : null;
  const withSelection = active && selectionOff ? { ...active, selection: null } : active;
  return { ...editor, active: withSelection, openEditors, dirtyFiles };
}

function filterInstructions(
  snapshot: ProjectSnapshot,
  exclusions: ReadonlySet<string> | readonly string[]
): ProjectSnapshot['instructions'] {
  if (has(exclusions, categoryExclusionKey('instructions'))) {
    return { documents: [], noneFound: true, truncated: null };
  }
  const documents = snapshot.instructions.documents.filter((doc) =>
    keepItem(exclusions, 'instructions', doc.path)
  );
  return { ...snapshot.instructions, documents, noneFound: documents.length === 0 };
}

function filterShape(
  snapshot: ProjectSnapshot,
  exclusions: ReadonlySet<string> | readonly string[]
): ProjectShape {
  if (!keepItem(exclusions, 'shape', 'tree')) {
    return EMPTY_SHAPE;
  }
  return snapshot.shape;
}

/**
 * Apply the per-turn exclusion set to a snapshot, so the text the delivery layer
 * sends is exactly the reduced set the strip and panel showed. Excluding a file
 * or category never adds anything back, and the filter is pure: the input
 * snapshot is untouched.
 */
export function applyContextExclusions(
  snapshot: ProjectSnapshot,
  exclusions: ReadonlySet<string> | readonly string[]
): ProjectSnapshot {
  if (toSet(exclusions).size === 0) {
    return snapshot;
  }
  const editor = filterEditor(snapshot.editor ?? EMPTY_EDITOR, exclusions);
  return {
    ...snapshot,
    instructions: filterInstructions(snapshot, exclusions),
    shape: filterShape(snapshot, exclusions),
    editor
  };
}

/**
 * Whether a settings snapshot still sends anything. A settings object whose
 * every category is off produces no context, which the strip must say plainly
 * rather than looking like a workspace with nothing in it.
 */
export function anyCategoryEnabled(settings: ContextSettings): boolean {
  return (
    settings.includeInstructions ||
    settings.includeShape ||
    settings.includeEditorState ||
    settings.includeSelection ||
    settings.includeChangedFiles
  );
}

/**
 * Overlay optimistic exclusions on a host-built view, so the strip and panel
 * reflect a toggle immediately while the host echo is in flight. The host view
 * remains the source of truth: once it arrives with the same exclusions, this is
 * a no-op. Counts and the summary chip are recomputed so the strip never claims
 * more is sent than the reduced set carries.
 */
export function applyViewExclusions(
  view: ContextView,
  exclusions: ReadonlySet<string> | readonly string[]
): ContextView {
  const keys = toSet(exclusions);
  if (keys.size === 0) {
    return view;
  }
  const categories = view.categories.map((entry) => {
    // The host view is the source of truth: an item the host already excluded
    // (for example an excluded secret file) stays excluded here, so it keeps its
    // reason instead of rendering as a blank row. A local key can only add.
    const categoryOff = keys.has(categoryExclusionKey(entry.id)) || entry.excluded;
    const items = entry.items.map((item) =>
      categoryOff || item.excluded || keys.has(itemExclusionKey(entry.id, item.id))
        ? { ...item, excluded: true }
        : item
    );
    return { ...entry, excluded: categoryOff, items };
  });
  const includedCount = categories.reduce(
    (sum, entry) => sum + entry.items.filter((item) => !item.excluded).length,
    0
  );
  const excludedCount = categories.reduce(
    (sum, entry) => sum + entry.items.filter((item) => item.excluded).length,
    0
  );
  const remainingGroups = categories.filter(
    (entry) =>
      entry.id !== 'editor' &&
      entry.id !== 'selection' &&
      !entry.excluded &&
      entry.items.some((item) => !item.excluded)
  ).length;

  // A toggle on the editor or selection must remove the matching indicator from
  // the strip at once, not only after the host echo, so an optimistic toggle
  // never shows a file or selection the next turn will not carry. The selection
  // is nested inside editor state, so an editor exclusion clears it too.
  const editorOff =
    keys.has(categoryExclusionKey('editor')) || keys.has(itemExclusionKey('editor', 'active'));
  const selectionOff =
    editorOff ||
    keys.has(categoryExclusionKey('selection')) ||
    keys.has(itemExclusionKey('selection', 'selection'));
  return {
    ...view,
    ...(editorOff ? { activeFile: undefined, activeFilePath: undefined } : {}),
    ...(selectionOff ? { selectionLines: 0 } : {}),
    categories,
    includedCount,
    excludedCount,
    remainingGroups
  };
}
