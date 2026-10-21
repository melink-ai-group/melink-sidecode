/**
 * Run one skill toggle/action and always produce a settleable result.
 *
 * The settings layer can reject (a locked configuration target) after some
 * fields were written, and config edits can throw on an unparsable file. A
 * handler that awaited those directly left the checkbox or action chip on
 * "Working..." forever because no `pending: false` message was posted. This
 * wrapper turns a throw into a readable outcome; the caller posts that outcome
 * in a `finally`-style path.
 */

export interface SkillOperationOutcome<T> {
  ok: boolean;
  value?: T;
  message: string;
}

export function skillOperationMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return 'The skill operation failed before it could finish. Try again.';
}

export async function runSkillOperation<T>(run: () => Promise<T>): Promise<SkillOperationOutcome<T>> {
  try {
    return { ok: true, value: await run(), message: '' };
  } catch (error) {
    return { ok: false, message: skillOperationMessage(error) };
  }
}
