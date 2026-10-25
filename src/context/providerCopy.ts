/**
 * Sentences we send to the model and never show in the chat.
 *
 * Kept in their own module so the webview can hide an echoed line without
 * importing the snapshot renderer.
 */

/** Sent on every turn until the user adds the file they are viewing. */
export const VIEWED_FILE_NOT_ATTACHED =
  'Current file: not attached. The user did not include the file they are viewing. Do not treat any other file as "this file".';

/** Sent when the user attached a file but no editor is open. */
export const VIEWED_FILE_NONE_OPEN =
  'Current file: the user asked to include the file they are viewing, but no file is open in the editor.';

/** Tells the model which path "this file" means after the user attaches it. */
export const ATTACHED_FILE_REFERENT =
  'The user attached the file they are viewing in the editor. When they say "this file", they mean this path and these contents. Do not substitute another file.';

/** Snapshot line that points at the separate per-turn attachment block. */
export const ATTACHED_FILE_SNAPSHOT_LINE =
  'Current file: attached for this turn in a separate block. When the user says "this file", use that attached file and not another path in this project.';

/**
 * Provider-only sentences. The transcript hides a line only when it is exactly
 * one of these. User wording is never scanned for phrases like "this file".
 */
export const PROVIDER_ONLY_LINES = [
  VIEWED_FILE_NOT_ATTACHED,
  VIEWED_FILE_NONE_OPEN,
  ATTACHED_FILE_REFERENT,
  ATTACHED_FILE_SNAPSHOT_LINE
] as const;

/** Keep variable per-turn repository details inside a provider-only block. */
export function repoMapPrompt(text: string | undefined): string | undefined {
  return text?.trim() ? `<repo-map>\n${text}\n</repo-map>` : undefined;
}
