import { saveScreenshot } from './screenshots.ts';

/** Shown in the snapshot text when the PNG could not be written. */
export const NO_WORKSPACE_SCREENSHOT_NOTE =
  'No workspace folder is open, so this screenshot was not saved to disk; the image above is still current.';

export interface SavedSnapshot {
  path?: string;
  note?: string;
}

/**
 * Save a snapshot PNG when a workspace folder exists. With no folder the
 * inline image still reaches the model, so this reports a note instead of
 * failing the whole snapshot.
 */
export async function saveSnapshotPng(
  root: string | undefined,
  shot: { pngBase64: string; title: string; url: string }
): Promise<SavedSnapshot> {
  if (!root) {
    return { note: NO_WORKSPACE_SCREENSHOT_NOTE };
  }
  return { path: await saveScreenshot(root, shot.pngBase64, shot.title, shot.url) };
}
