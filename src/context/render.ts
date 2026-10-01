/**
 * The one renderer for project context, shared by every backend.
 *
 * A snapshot (or a delta between two snapshots) is turned into a bounded,
 * human-readable text block here, so the wording and the budget are defined
 * once. The direct Ollama adapter, the Codex adapter and the opencode adapter
 * all import this module; none of them formats context itself.
 *
 * ## Host-free by construction
 *
 * This module imports the snapshot types and `cutToBytes` from
 * `projectContext.ts`, plus the provider sentences from `providerCopy.ts`.
 * It never imports `vscode` and never touches a provider,
 * so its output is deterministic and `npm test`-able headlessly.
 *
 * ## Invariants
 *
 * - **Total.** Rendering never throws. A malformed or empty snapshot degrades
 *   to a plain-language notice rather than failing the turn that asked for it.
 * - **Bounded.** Every block is cut to `budget` bytes on a UTF-8 boundary, and
 *   truncation is marked, so a huge workspace cannot blow the prompt.
 * - **Stable prefix, small delta.** The snapshot block is deterministic, so it
 *   stays cacheable across turns; a delta names only what changed.
 */

import {
  ATTACHED_FILE_REFERENT,
  ATTACHED_FILE_SNAPSHOT_LINE,
  VIEWED_FILE_NONE_OPEN,
  VIEWED_FILE_NOT_ATTACHED
} from './providerCopy.ts';
import {
  cutToBytes,
  type ExclusionReason,
  type ProjectDelta,
  type ProjectSnapshot,
  type ViewedFileAttachment
} from './projectContext.ts';

export {
  ATTACHED_FILE_REFERENT,
  ATTACHED_FILE_SNAPSHOT_LINE,
  PROVIDER_ONLY_LINES,
  VIEWED_FILE_NONE_OPEN,
  VIEWED_FILE_NOT_ATTACHED
} from './providerCopy.ts';

/** Byte caps for the rendered blocks. Snapshots are large; deltas are tiny. */
export interface RenderBudget {
  /** Overall byte cap for a rendered snapshot block. */
  snapshot: number;
  /** Overall byte cap for a rendered delta block. */
  delta: number;
  /** Largest number of languages named in the snapshot. */
  languages: number;
  /** Largest number of tree nodes described. */
  tree: number;
  /** Largest number of instruction documents quoted. */
  documents: number;
}

export const DEFAULT_RENDER_BUDGET: RenderBudget = {
  snapshot: 8_192,
  delta: 1_024,
  languages: 8,
  tree: 40,
  documents: 4
};

/** The markers that delimit a rendered block, so a model can tell them apart. */
export const SNAPSHOT_OPEN = '<project-context>';
export const SNAPSHOT_CLOSE = '</project-context>';
export const DELTA_OPEN = '<project-context-update>';
export const DELTA_CLOSE = '</project-context-update>';
export const ATTACHED_FILE_OPEN = '<attached-file>';
export const ATTACHED_FILE_CLOSE = '</attached-file>';

const ATTACH_REASON: Record<ExclusionReason, string> = {
  secret: 'it looks like a secret store',
  'key-material': 'it looks like key material',
  dependency: 'it is a dependency directory',
  vcs: 'it is version-control metadata',
  build: 'it is build output',
  binary: 'it is a binary file',
  lockfile: 'it is a lockfile',
  excluded: 'it matches an exclude pattern',
  user: 'it matches an exclude list'
};

/** The stable prefix every snapshot opens with, so the model knows its role. */
const SNAPSHOT_INTRO =
  'Project context from the editor. This describes the workspace you are working in. ' +
  'Use it to answer questions about the project; you do not need to ask the user for it.';

/** A plain-language line used when a snapshot cannot be built or is empty. */
export const CONTEXT_UNAVAILABLE_NOTICE =
  'Project context is not available right now. Continue without it; do not block the turn.';

export interface RenderSnapshotOptions {
  budget?: RenderBudget;
}

/**
 * Render a full snapshot as a bounded text block. Never throws: an empty or
 * malformed snapshot degrades to a notice inside the block.
 */
export function renderSnapshot(
  snapshot: ProjectSnapshot,
  options: RenderSnapshotOptions = {}
): string {
  const budget = options.budget ?? DEFAULT_RENDER_BUDGET;
  const lines: string[] = [SNAPSHOT_OPEN, SNAPSHOT_INTRO];

  try {
    renderWorkspace(snapshot, lines);
    renderPurpose(snapshot, lines, budget);
    renderLanguages(snapshot, lines, budget);
    renderEntryPoints(snapshot, lines);
    renderManifests(snapshot, lines);
    renderLayout(snapshot, lines, budget);
    renderEditor(snapshot, lines);
    renderInstructions(snapshot, lines, budget);
    renderExclusions(snapshot, lines);
    renderTruncation(snapshot, lines);
  } catch {
    // Rendering is best-effort: a shape this pinned renderer did not expect must
    // not fail the turn. The notice keeps the model honest about the gap.
    lines.push(CONTEXT_UNAVAILABLE_NOTICE);
  }

  lines.push(SNAPSHOT_CLOSE);
  return cutToBytes(lines.join('\n'), budget.snapshot).text;
}

/**
 * Render a snapshot, reporting instead of throwing when one cannot be produced.
 * The host uses this so a failed or empty snapshot degrades to a notice that is
 * sent to the model, and the turn is never blocked.
 */
export function renderSnapshotResult(
  snapshot: ProjectSnapshot | undefined,
  options: RenderSnapshotOptions = {}
): { ok: true; text: string } | { ok: false; notice: string } {
  if (!snapshot) {
    return { ok: false, notice: CONTEXT_UNAVAILABLE_NOTICE };
  }
  try {
    return { ok: true, text: renderSnapshot(snapshot, options) };
  } catch {
    return { ok: false, notice: CONTEXT_UNAVAILABLE_NOTICE };
  }
}

/**
 * Render the change between two snapshots. Returns `null` when nothing meaningful
 * changed, so the adapter can send nothing rather than an empty block.
 */
export function renderDelta(
  delta: ProjectDelta,
  snapshot: ProjectSnapshot,
  options: RenderSnapshotOptions = {}
): string | null {
  if (!delta.changed) {
    return null;
  }
  const budget = options.budget ?? DEFAULT_RENDER_BUDGET;
  const lines: string[] = [DELTA_OPEN, 'Project context changed since the last turn.'];

  try {
    if (delta.workspace) {
      const workspace = snapshot.workspace;
      const where = workspace.branch ? `branch ${workspace.branch}` : 'the workspace';
      lines.push(`Workspace changed (${where}).`);
    }
    if (delta.files) {
      const added = delta.files.added.slice(0, 20);
      const removed = delta.files.removed.slice(0, 20);
      if (added.length > 0) {
        lines.push(`Files added: ${added.join(', ')}.`);
      }
      if (removed.length > 0) {
        lines.push(`Files removed: ${removed.join(', ')}.`);
      }
    }
    if (delta.activeEditor || delta.selection) {
      const active = snapshot.editor.active;
      if (active) {
        lines.push(`Active file: ${activeEditorLabel(active)}.`);
        if (active.selection) {
          lines.push(`Selection: ${selectionLabel(active.selection)}.`);
        }
      }
    }
    if (delta.openEditors) {
      const open = snapshot.editor.openEditors.slice(0, 20).map((editor) => editorLabel(editor));
      if (open.length > 0) {
        lines.push(`Open editors: ${open.join(', ')}.`);
      }
    }
    if (delta.dirtyFiles) {
      if (snapshot.editor.dirtyFiles.length > 0) {
        lines.push(`Unsaved files: ${snapshot.editor.dirtyFiles.slice(0, 20).join(', ')}.`);
      } else {
        lines.push('There are no unsaved files.');
      }
    }
  } catch {
    return null;
  }

  if (lines.length <= 2) {
    return null;
  }
  lines.push(DELTA_CLOSE);
  return cutToBytes(lines.join('\n'), budget.delta).text;
}

/* -------------------------------------------------------------------------- */
/* Section renderers                                                          */
/* -------------------------------------------------------------------------- */

function renderWorkspace(snapshot: ProjectSnapshot, lines: string[]): void {
  const { names, roots, multiRoot, branch, remote } = snapshot.workspace;
  if (roots.length === 0) {
    lines.push('Workspace: no folder is open.');
    return;
  }
  lines.push(`Project name: ${names.join(', ') || '(unnamed)'}.`);
  lines.push(`Project root: ${roots.join(', ')}.`);
  if (multiRoot) {
    lines.push('This is a multi-root workspace.');
  }
  if (branch) {
    lines.push(`Git branch: ${branch}.`);
  }
  if (remote) {
    lines.push(`Git remote: ${remote}.`);
  }
}

/**
 * Derive the project's purpose from its instruction documents, preferring the
 * README and then `AGENTS.md`. This is what makes "what is this project about?"
 * answerable without the user pasting anything.
 */
function renderPurpose(snapshot: ProjectSnapshot, lines: string[], budget: RenderBudget): void {
  const doc = purposeDocument(snapshot);
  if (!doc) {
    lines.push('Purpose: not stated in the project instructions or README.');
    return;
  }
  const purpose = firstParagraph(doc.excerpt);
  if (!purpose) {
    lines.push('Purpose: not stated in the project instructions or README.');
    return;
  }
  const bounded = cutToBytes(purpose, Math.max(256, Math.floor(budget.snapshot / 8))).text;
  lines.push(`Purpose (from ${doc.path}): ${bounded}`);
}

function purposeDocument(snapshot: ProjectSnapshot): ProjectSnapshot['instructions']['documents'][number] | undefined {
  const docs = snapshot.instructions.documents;
  return docs.find((doc) => doc.kind === 'readme') ?? docs.find((doc) => doc.kind === 'agents');
}

/** The first non-heading, non-empty paragraph of a markdown excerpt. */
function firstParagraph(excerpt: string): string {
  const lines = excerpt.split(/\r?\n/).map((line) => line.trim());
  const paragraph: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (line.startsWith('#')) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line);
  }
  return paragraph.join(' ').replace(/\s+/g, ' ').trim();
}

function renderLanguages(snapshot: ProjectSnapshot, lines: string[], budget: RenderBudget): void {
  const languages = snapshot.shape.languages.slice(0, budget.languages);
  if (languages.length === 0) {
    lines.push('Main languages: none detected.');
    return;
  }
  lines.push(
    `Main languages: ${languages.map((entry) => `${entry.language} (${entry.files} files)`).join(', ')}.`
  );
}

function renderEntryPoints(snapshot: ProjectSnapshot, lines: string[]): void {
  const entryPoints = snapshot.shape.manifests.filter((hit) => hit.kind.endsWith('/'));
  if (entryPoints.length === 0) {
    return;
  }
  lines.push(`Entry point directories: ${entryPoints.map((hit) => hit.path).join(', ')}.`);
}

function renderManifests(snapshot: ProjectSnapshot, lines: string[]): void {
  const manifests = snapshot.shape.manifests.filter((hit) => !hit.kind.endsWith('/'));
  if (manifests.length === 0) {
    lines.push('Manifests: none detected.');
    return;
  }
  lines.push('Manifests:');
  for (const manifest of manifests) {
    const fields = manifest.fields
      ? Object.entries(manifest.fields)
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')
      : '';
    lines.push(`- ${manifest.path}${fields ? ` (${fields})` : ''}`);
  }
}

function renderLayout(snapshot: ProjectSnapshot, lines: string[], budget: RenderBudget): void {
  const tree = snapshot.shape.tree.slice(0, budget.tree);
  if (tree.length === 0) {
    lines.push('Layout: no directories described.');
    return;
  }
  lines.push('Layout (top levels):');
  for (const node of tree) {
    const indent = '  '.repeat(Math.max(0, node.depth - 1));
    lines.push(`${indent}- ${node.name}/`);
  }
}

/** Wrap a viewed-file status line in the same block the transcript already hides. */
export function renderViewedFileNotice(notice: string): string {
  return [ATTACHED_FILE_OPEN, notice, ATTACHED_FILE_CLOSE].join('\n');
}

/**
 * The per-turn block for the file the user explicitly attached. This is not
 * part of the stable snapshot, so a later file switch is what the next turn sees.
 */
export function renderAttachedFile(file: ViewedFileAttachment): string {
  const lines = [
    ATTACHED_FILE_OPEN,
    ATTACHED_FILE_REFERENT,
    `Path: ${file.path} (${file.languageId}).`
  ];
  if (file.excluded) {
    const reason = file.exclusionReason ? ATTACH_REASON[file.exclusionReason] : 'it is excluded';
    lines.push(`This file is excluded because ${reason}, so its contents are not included.`);
  } else if (file.text && file.text.length > 0) {
    lines.push('Contents:');
    lines.push(file.text);
    if (file.truncated) {
      lines.push('Note: the file contents above were truncated to fit the context budget.');
    }
  } else {
    lines.push('The file is empty.');
  }
  if (file.selection) {
    lines.push('Selected text:');
    lines.push(file.selection);
  }
  lines.push(ATTACHED_FILE_CLOSE);
  return lines.join('\n');
}

function renderEditor(snapshot: ProjectSnapshot, lines: string[]): void {
  const editor = snapshot.editor;
  if (editor.activeFileAttached === true) {
    lines.push(ATTACHED_FILE_SNAPSHOT_LINE);
  } else if (editor.activeFileAttached === false) {
    lines.push(VIEWED_FILE_NOT_ATTACHED);
  } else if (editor.active) {
    lines.push(`Active file: ${activeEditorLabel(editor.active)}.`);
    if (editor.active.excluded) {
      lines.push(
        `The active file is excluded from context (${editor.active.exclusionReason ?? 'excluded'}); its contents are not quoted.`
      );
    } else if (editor.active.selection) {
      lines.push(`Selection: ${selectionLabel(editor.active.selection)}.`);
      if (editor.active.selection.text) {
        lines.push('Selected text:');
        lines.push(editor.active.selection.text);
      }
    }
  } else {
    lines.push('Active file: none.');
  }
  if (editor.openEditors.length > 0) {
    lines.push(`Open editors: ${editor.openEditors.map((open) => editorLabel(open)).join(', ')}.`);
  }
  if (editor.dirtyFiles.length > 0) {
    lines.push(`Unsaved files: ${editor.dirtyFiles.join(', ')}.`);
  }
  if (editor.terminalCwd) {
    lines.push(`Terminal working directory: ${editor.terminalCwd}.`);
  }
}

function renderInstructions(snapshot: ProjectSnapshot, lines: string[], budget: RenderBudget): void {
  const documents = snapshot.instructions.documents.slice(0, budget.documents);
  if (documents.length === 0) {
    lines.push('Project instructions: none found.');
    return;
  }
  lines.push('Project instructions:');
  for (const document of documents) {
    lines.push(`--- ${document.path}${document.truncated ? ' (truncated)' : ''} ---`);
    lines.push(document.excerpt);
  }
}

function renderExclusions(snapshot: ProjectSnapshot, lines: string[]): void {
  const directories = snapshot.exclusions.directories;
  const patterns = snapshot.exclusions.patterns;
  const parts = [...directories, ...patterns].slice(0, 30);
  if (parts.length === 0) {
    return;
  }
  lines.push(
    `Excluded from context (never read): ${parts.join(', ')}. A selection inside an excluded file is reported, not quoted.`
  );
}

function renderTruncation(snapshot: ProjectSnapshot, lines: string[]): void {
  const markers = [
    snapshot.truncated,
    snapshot.shape.truncated,
    snapshot.instructions.truncated,
    snapshot.editor.truncated,
    snapshot.workspace.truncated
  ].filter((marker): marker is string => Boolean(marker));
  if (markers.length > 0) {
    lines.push(`Note: some categories were truncated: ${markers.join('; ')}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Small label helpers                                                        */
/* -------------------------------------------------------------------------- */

function activeEditorLabel(active: ProjectSnapshot['editor']['active']): string {
  if (!active) {
    return 'none';
  }
  const path = active.relativePath ?? active.absolutePath;
  return `${path} (${active.languageId})`;
}

function editorLabel(editor: ProjectSnapshot['editor']['openEditors'][number]): string {
  const path = editor.relativePath ?? editor.absolutePath;
  return `${path}${editor.isDirty ? ' *' : ''}`;
}

function selectionLabel(selection: NonNullable<ProjectSnapshot['editor']['active']>['selection']): string {
  if (!selection) {
    return 'none';
  }
  const range = `lines ${selection.startLine}:${selection.startColumn}-${selection.endLine}:${selection.endColumn}`;
  return selection.text ? `${range} (selected text included)` : range;
}
