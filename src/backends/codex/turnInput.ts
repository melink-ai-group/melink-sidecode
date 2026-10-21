/**
 * Provider-only Codex turn input.
 *
 * The sidebar transcript stores the user's text. This module builds the input
 * the app-server actually receives: the current mode, a workspace delta, a
 * refreshed snapshot when the host re-primed, and the files attached to the
 * turn. None of that is written back to the transcript.
 */

import type { Attachment, ContextPayload, DefaultMode } from '../types.ts';
import type { FrontendStack } from '../../context/frontendStack.ts';
import { modeInstructions } from '../modes.ts';
import type { UserInput } from '../../../schemas/v2/UserInput.ts';

export interface CodexTurnInput {
  mode: DefaultMode;
  /** The user text, unchanged. */
  text: string;
  /** Frontend stack from the turn's context, for the acting-mode checklist. */
  frontendStack?: FrontendStack;
  context?: ContextPayload;
  attachments?: readonly Attachment[];
  /**
   * Mode last written into `developerInstructions`, when this thread has one.
   * A different mode adds one sentence that retires the earlier instructions.
   */
  bakedMode?: DefaultMode;
  /**
   * True when this turn must carry a new project snapshot because the host
   * re-primed (a refresh or an exclusion change).
   */
  includeSnapshot?: boolean;
  /**
   * True when an earlier developer instruction required Plan mode. The turn
   * states that the restriction is finished.
   */
  revokePlan?: boolean;
}

/** Developer instruction for a thread forked out of a Plan-mode session. */
export function planEscapeInstructions(snapshot?: string): string {
  const notice =
    'Ignore every earlier developer instruction, every earlier turn, and every earlier refusal that required Plan mode or prohibited implementation. Those rules are finished. Follow the mode at the start of the latest user turn. When that turn asks to build or implement a plan, do the work.';
  return snapshot && snapshot.trim().length > 0 ? `${notice}\n\n${snapshot}` : notice;
}

const MODE_NAME: Record<DefaultMode, string> = {
  agent: 'Agent',
  plan: 'Plan',
  ask: 'Ask'
};

/** The `turn/start` input for one user message. */
export function buildCodexTurnInput(input: CodexTurnInput): UserInput[] {
  const text = providerText(input);
  return [{ type: 'text', text, text_elements: [] }, ...imageInputs(input.attachments)];
}

function providerText(input: CodexTurnInput): string {
  const parts: string[] = [];
  if (input.revokePlan || (input.bakedMode !== undefined && input.bakedMode !== input.mode)) {
    const previous =
      input.bakedMode !== undefined && input.bakedMode !== input.mode ? MODE_NAME[input.bakedMode] : 'Plan';
    parts.push(
      `The developer instruction that required ${previous} mode is revoked. It no longer applies, including any rule that prohibited implementation. The active developer instruction for this turn is ${MODE_NAME[input.mode]} mode.`
    );
  }
  const instructions = modeInstructions(input.mode, input.frontendStack);
  if (instructions) {
    parts.push(instructions);
  }

  const context = input.context;
  if (input.includeSnapshot && context?.snapshot) {
    parts.push(
      `The project context below replaces the project context from the start of this thread.\n\n${context.snapshot}`
    );
  } else if (context?.notice && !context.snapshot) {
    parts.push(context.notice);
  }
  if (context?.delta) {
    parts.push(context.delta);
  }
  if (context?.repoMap) {
    parts.push(context.repoMap);
  }
  if (context?.attachedFile) {
    parts.push(context.attachedFile);
  }

  const files = attachmentLines(input.attachments);
  if (files) {
    parts.push(files);
  }
  parts.push(input.text);
  return parts.filter((part) => part.trim().length > 0).join('\n\n');
}

/** One line per attached file, so a path reaches the model even when the bytes do not. */
function attachmentLines(attachments: readonly Attachment[] | undefined): string | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  const lines = attachments.map((attachment) => {
    const where = attachment.path ? `${attachment.name} (${attachment.path})` : attachment.name;
    return attachment.kind === 'image' ? `Image: ${where}` : `File: ${where}`;
  });
  return ['Attached files:', ...lines].join('\n');
}

/**
 * Images the protocol can carry. A picked file uses `localImage`. A clipboard
 * image has no path, so it uses the `image` url form and its data URL.
 */
function imageInputs(attachments: readonly Attachment[] | undefined): UserInput[] {
  const images: UserInput[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== 'image') {
      continue;
    }
    if (attachment.path) {
      images.push({ type: 'localImage', path: attachment.path });
      continue;
    }
    if (attachment.dataUrl) {
      images.push({ type: 'image', url: attachment.dataUrl });
    }
  }
  return images;
}
