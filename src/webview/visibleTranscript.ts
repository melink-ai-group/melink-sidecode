/**
 * Hide default instructions and project-context blocks from the chat.
 *
 * Mode instructions and the rendered project snapshot are provider input. A
 * backend that echoes them, or a model that repeats them, must not dump that
 * text into the transcript. The user's own words and the assistant's real
 * reply stay.
 *
 * Provider sentences are removed only when a line is exactly one of the
 * sentences we send. The transcript never scans for words like "this file".
 */

import { PROVIDER_ONLY_LINES } from '../context/providerCopy.ts';
import { takeAttachmentSection } from '../backends/userPrompt.ts';
import { hideQuestionFence } from '../questions.ts';
import { hideSubagentFence } from '../orchestration/delegation.ts';

const CLOSED_BLOCK =
  /<(project-context|project-context-update|attached-file|repo-map)>[\s\S]*?<\/\1>/g;

const MODE_LINE = /^Work in (?:Agent|Plan|Ask) mode\.[^\n]*$/gm;

/** One paragraph Codex adds when a resumed thread leaves Plan mode. */
const REVOKED_MODE = /^The developer instruction that required [\s\S]*?(?=\n\n|$)/;

/** The sentence in front of a replacement project snapshot. */
const SNAPSHOT_INTRO = /^The project context below replaces the project context from the start of this thread\.\n*/;

const OPEN_BLOCK = /<(project-context|project-context-update|attached-file|repo-map)>/;

/** Exact legacy status lines, before repository maps were wrapped in tags. */
const LEGACY_REPO_MAP = /^Repo map: (?:disabled \(melink\.context\.repoMap is off\)|unavailable \(no workspace snapshot or file reads\)|failed \(one or more files could not be read\)|no matching files for this request|no source files found|limited \(caps files=\d+, bytes=\d+, ms=\d+, symbols=\d+\))\.$/;

const PROVIDER_LINE = new Set<string>(PROVIDER_ONLY_LINES);

/** Transcript text with injected instructions, context blocks, and question payloads removed. */
export function visibleTranscriptText(text: string): string {
  let next = takeAttachmentSection(text).text;
  next = next.replace(REVOKED_MODE, '');
  next = next.replace(SNAPSHOT_INTRO, '');
  next = next.replace(CLOSED_BLOCK, '');
  next = next.replace(MODE_LINE, '');
  next = stripProviderLines(next);
  next = stripUnclosedPrompt(next);
  next = hideQuestionFence(next);
  next = hideSubagentFence(next);
  return next.replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop a line only when it is one of our own provider sentences, verbatim. */
function stripProviderLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !PROVIDER_LINE.has(line.trim()) && !LEGACY_REPO_MAP.test(line.trim()))
    .join('\n');
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
