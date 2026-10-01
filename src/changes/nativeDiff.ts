import type { ChangeStatus } from '../backends/types';

/**
 * The host-free planning half of the native workbench diff integration.
 *
 * The sidebar is the wrong place to read a 400-line diff, so a review row hands
 * the full-fidelity job to the workbench: the single-file diff editor and the
 * multi-file changes editor. Both are driven from URIs, and the left-hand side
 * must be the *pre-turn* content the journal recorded, never a temp file.
 *
 * This module owns exactly the parts that do not need VS Code so they can be
 * unit-tested headless:
 *
 * - the `melink-changes:` scheme and the URI codec for a virtual document
 *   (turn id, workspace-relative path, and which side),
 * - the rule that maps a recorded file status to a left/right pair of virtual,
 *   empty, or working-file sides, and
 * - the same rule expressed as a row for `vscode.changes`.
 *
 * The thin `vscode.Uri` / `registerTextDocumentContentProvider` binding lives in
 * `vscodeDiff.ts`, mirroring `vscodeJournal.ts`. No `vscode` import, no I/O, and
 * no temp artefact: content is served from the journal blob store.
 */

/** The virtual scheme the content provider is registered on. */
export const MELINK_CHANGES_SCHEME = 'melink-changes';

/**
 * Command ids the review surface invokes. They are stable and documented so
 * t5's `Open in editor` affordance has a real, registered target rather than a
 * hand-rolled viewer. Each degrades to a no-op with an explanatory message when
 * the data it needs is gone, never a thrown error.
 */
/** Open one changed file's pre-turn vs working diff in the built-in diff editor. */
export const OPEN_CHANGE_DIFF_COMMAND = 'melink.openChangeDiff';
/** Open the whole turn in the built-in multi-file changes editor. */
export const OPEN_TURN_CHANGES_COMMAND = 'melink.openTurnChanges';
/** Reveal one changed file in the Source Control view (fallback affordance). */
export const REVEAL_CHANGE_IN_SCM_COMMAND = 'melink.revealChangeInSourceControl';

/** Which side of a virtual document a URI names. */
export type VirtualSide = 'before' | 'empty';

/** A virtual document the content provider can serve. */
export interface VirtualDocument {
  turnId: string;
  /** Workspace-relative, POSIX-separated path (carried in the URI path). */
  relPath: string;
  side: VirtualSide;
}

/** The string components of a virtual document URI, kept host-free. */
export interface VirtualUriParts {
  path: string;
  query: string;
}

/**
 * The `path`/`query` components for a virtual document. The path keeps the file
 * name and extension so the diff editor infers a language for syntax colouring;
 * the turn and side are query parameters, so two turns of the same path are
 * distinct URIs.
 */
export function virtualUriParts(document: VirtualDocument): VirtualUriParts {
  const params = new URLSearchParams();
  params.set('turnId', document.turnId);
  params.set('side', document.side);
  return {
    path: `/${document.relPath.replace(/^\/+/, '')}`,
    query: params.toString()
  };
}

/**
 * Parse a virtual document back from its `path`/`query`. Returns `undefined` for
 * anything that is not a well-formed `melink-changes:` URI, so a stray request
 * serves an empty document rather than throwing.
 */
export function parseVirtualDocument(uri: { path: string; query: string }): VirtualDocument | undefined {
  const params = new URLSearchParams(uri.query);
  const turnId = params.get('turnId');
  const side = params.get('side');
  if (!turnId || (side !== 'before' && side !== 'empty')) {
    return undefined;
  }
  const relPath = uri.path.replace(/^\/+/, '');
  if (relPath.length === 0) {
    return undefined;
  }
  return { turnId, relPath, side };
}

/** One side of a diff: the working file, the journal's pre-turn content, or empty. */
export type DiffSide = { kind: 'file' } | { kind: 'virtual'; side: VirtualSide };

/** The recorded facts a side decision depends on. */
export interface DiffSideInput {
  status: ChangeStatus;
  /** True when the journal stored a pre-turn blob for the file. */
  hasBefore: boolean;
  /** True when a post-turn working file exists. */
  hasAfter: boolean;
}

/**
 * The left/right pair for a single-file diff.
 *
 * - A `created` file has no pre-turn side, so the left is empty.
 * - A `deleted` file has no working file, so the right is empty.
 * - Everything else diffs the journal's pre-turn content against the working
 *   file. A file whose before blob was not stored falls back to an empty left
 *   rather than a missing-URI error.
 */
export function diffSides(input: DiffSideInput): { left: DiffSide; right: DiffSide } {
  if (input.status === 'created' || !input.hasBefore) {
    return { left: { kind: 'virtual', side: 'empty' }, right: { kind: 'file' } };
  }
  if (input.status === 'deleted' || !input.hasAfter) {
    return { left: { kind: 'virtual', side: 'before' }, right: { kind: 'virtual', side: 'empty' } };
  }
  return { left: { kind: 'virtual', side: 'before' }, right: { kind: 'file' } };
}

/** The URI identity a `vscode.changes` row is labelled with. */
export type DiffLabel = { kind: 'file' } | { kind: 'virtual'; side: VirtualSide };

/** One row of the multi-file changes editor. */
export interface ChangesViewRow {
  label: DiffLabel;
  original: DiffSide;
  modified: DiffSide;
}

/**
 * A row for `vscode.changes`. The label identifies the file; a deleted file has
 * no working URI, so its label is the virtual pre-turn document. Original is the
 * left-hand side and modified the right, matching the `vscode.changes` contract.
 */
export function changesViewRow(input: DiffSideInput): ChangesViewRow {
  const sides = diffSides(input);
  const label: DiffLabel =
    input.status === 'deleted' || !input.hasAfter ? { kind: 'virtual', side: 'before' } : { kind: 'file' };
  return { label, original: sides.left, modified: sides.right };
}

/**
 * Resolve a `melink-changes:` URI to the bytes the content provider should
 * serve, without knowing VS Code. An `empty` side is the empty string; a
 * `before` side is the journal's stored pre-turn content, or the empty string
 * when it is no longer available (never an error, so a diff still opens).
 */
export async function resolveVirtualContent(
  document: VirtualDocument,
  readBefore: (turnId: string, relPath: string) => Promise<Uint8Array | undefined>
): Promise<string> {
  if (document.side === 'empty') {
    return '';
  }
  const bytes = await readBefore(document.turnId, document.relPath);
  return bytes ? new TextDecoder().decode(bytes) : '';
}
