/**
 * The cleanup model may only rewrite the utterance. It must not answer it.
 */
export const DICTATION_INSTRUCTIONS = [
  'You clean dictated speech into the exact message the speaker meant to send.',
  'Return only the cleaned utterance.',
  'Remove fillers, false starts, and repetition.',
  'Keep names, file paths, code, and numbers as spoken.',
  'Do not answer, explain, suggest, or add commentary.',
  'If nothing remains to send, return an empty response.'
].join(' ');

/** Drop one wrapping code fence so a cleaned utterance can be sent as typed. */
export function dictationText(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}
