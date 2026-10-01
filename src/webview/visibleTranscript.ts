/**
 * Hide default instructions and project-context blocks from the chat.
 *
 * Mode instructions and the rendered project snapshot are provider input. A
 * backend that echoes them, or a model that repeats them, must not dump that
 * text into the transcript. The user's own words and the assistant's real
 * reply stay.
 */

const CLOSED_BLOCK =
  /<(project-context|project-context-update|attached-file)>[\s\S]*?<\/\1>/g;

const MODE_LINE = /^Work in (?:Agent|Plan|Ask) mode\.[^\n]*$/gm;

const OPEN_BLOCK = /<(project-context|project-context-update|attached-file)>/;

/** Transcript text with injected instructions and context blocks removed. */
export function visibleTranscriptText(text: string): string {
  let next = text.replace(CLOSED_BLOCK, '');
  next = next.replace(MODE_LINE, '');
  next = stripUnclosedPrompt(next);
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * An echoed prompt can still be streaming, so the closing tag has not arrived.
 * Hide from the opening tag to the end only when the text before it is empty
 * or is itself just the mode instruction. A tag mentioned inside a real answer
 * is left alone.
 */
function stripUnclosedPrompt(text: string): string {
  const match = OPEN_BLOCK.exec(text);
  if (!match) {
    return text;
  }
  const close = `</${match[1]}>`;
  if (text.includes(close)) {
    return text;
  }
  const before = text.slice(0, match.index).trim();
  if (before.length > 0 && !/^Work in (?:Agent|Plan|Ask) mode\./.test(before)) {
    return text;
  }
  return text.slice(0, match.index);
}
