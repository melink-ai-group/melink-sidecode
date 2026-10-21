import { DEFAULT_MODES, type DefaultMode, type PermissionLevel } from './types.ts';
import { frontendChecklist, type FrontendStack } from '../context/frontendStack.ts';

/**
 * The one place the shared `DefaultMode` is translated into Codex's own
 * vocabulary, and the one place the mode's enforcement policy lives.
 *
 * ## Native support, and the deliberate divergence
 *
 * The generated bindings expose a `CollaborationMode`/`ModeKind` type, but there
 * is **no client request that sets it**: `CollaborationMode` appears only on the
 * read-only `ThreadSettings`, and the app-server offers no
 * `thread/setCollaborationMode`-style method. A `mode: "plan"` cannot therefore
 * be pushed over the wire. So Plan and Ask are implemented as a prompt
 * (`developerInstructions`, a real wire field) rather than by a native mode
 * switch. Ask is enforced as answer-only; Plan uses the selected permission
 * level so the provider can write when that level allows it.
 *
 * The native plan *tracking* side does exist (`turn/plan/updated` carrying
 * `TurnPlanStep[]`), and the adapter subscribes to it, so a plan the CLI does
 * produce is carried through the same neutral event stream. Native tracking is
 * used where it exists; native mode selection is not available and is not faked.
 */

/** Whether a mode forces the workspace read-only, whatever level was chosen. */
export type ModeEnforcement = 'act' | 'read-only' | 'answer-only';

export interface ModeDescriptor {
  mode: DefaultMode;
  label: string;
  /** One sentence for the settings screen, describing what the mode does. */
  description: string;
  /**
   * What the mode enforces on the workspace. `agent` and `plan` use the selected
   * permission level; `ask` answers and refuses to act at all.
   */
  enforcement: ModeEnforcement;
  /**
   * The `developerInstructions` Codex receives. These shape the model's
   * behaviour; they are never the only line of defence.
   */
  developerInstructions?: string;
}

/**
 * How Plan and Agent pause for a decision. The host renders the block as a
 * choice card and adds the custom-message option itself.
 */
/**
 * Visible shape of a reply. Tables and single newlines are rendered, so the
 * model has to write them as real rows and real breaks.
 */
const REPLY_SHAPE =
  'Write short paragraphs separated by a blank line. Put each list item and each table row on its own line. A table needs a header row and a `| --- |` separator row.';

/**
 * The last visible sentence. A trailing "Want me to..." reads as an unfinished
 * reply; the result of the request belongs in this sentence instead.
 */
const REPLY_CLOSE =
  'End with one short plain sentence in its own paragraph that states the result of this request: the answer, what you changed, or what is still blocked. That sentence is the last thing the user reads, and the host shows it apart from the notes above it. Do not end on a table, a list, a code span, or a trailing offer such as "Want me to".';

const QUESTION_BLOCK =
  'When you need a decision from the user, write that closing sentence first, then stop and end your reply with one fenced sidecode-question block and do not continue until the answers arrive. The block is JSON of the form {"questions":[{"prompt":"...","options":["preferred answer","next-best answer"]}]}. The prompt is one clear sentence. Put the preferred answer first. The host adds a custom-message choice, so do not add one yourself. If an answer is skipped or omitted, do not assume an answer: re-ask the question, or choose the least-destructive option and state the assumption you made.';

/**
 * Where generated documents go. Codex and OpenCode both receive the mode text,
 * so this is the one rule for both. The host writes the single plan file at
 * `.melink/plans/<friendly-name>.md` from the reply. The model must not also
 * write a plan, or a thread-id copy appears beside the friendly file.
 */
const ARTIFACT_HOME =
  'When you write a report, investigation, design note, or other generated document to disk, save it under `.melink/reports/` and nowhere else. Do not create or write those files in `docs/` or `reports/`. A documentation file the project already keeps stays where it is when the user asks you to edit that file. Do not create a plan file yourself. The host saves the one plan from your reply at `.melink/plans/<kebab-case title>.md`. Never create a second plan file, and never name a plan after a thread id or uuid.';

/**
 * The shared engineering definition of done for the modes that may act. It
 * names the checks by role, never by this repository's commands, so the model
 * reads the project it is in rather than assuming another project's scripts.
 */
const ENGINEERING_DEFINITION_OF_DONE =
  'Definition of done: read the project\u2019s `package.json` scripts and its README or contributor docs to identify the actual install/build, lint, typecheck, test, and run/dev commands; never assume another repository\u2019s commands.';

/** Agent must run the checks it found, not just name them. */
const AGENT_DEFINITION_OF_DONE = `${ENGINEERING_DEFINITION_OF_DONE} Run every applicable check from that set, and when the target is a web page or app also inspect its console, runtime, and network errors. Report each check\u2019s result or failure before your closing sentence; never claim a check passed without running it.`;

/** Plan names its verification and puts it in the plan; it still does not run it. */
const PLAN_DEFINITION_OF_DONE = `${ENGINEERING_DEFINITION_OF_DONE} Name the verification commands this plan depends on, include verification with its expected result in the plan body and steps, and do not run those commands while planning.`;

/**
 * The one git-safety rule for every mode that can act. Git writes can discard
 * user work and can bypass the host's Keep/Reject/checkpoint flow, so the model
 * asks first even when a general task sounds like permission to commit.
 */
export const GIT_SAFETY =
  'Git safety. Never run `git commit`, `git push`, `git reset`, `git clean`, or any other git operation that rewrites history or discards work unless the user explicitly requested that exact action in this conversation; a general request such as "fix the bug" or "clean this up" is not permission. Before running ANY git write, including `git add`, `git commit`, `git push`, `git reset`, `git clean`, `git checkout -f`, `git rebase`, `git tag`, `git branch -D`, `git stash drop`, or a force push, state the exact command and ask for the user\u2019s approval. Read-only git (`git status`, `git diff`, `git log`, `git show`) needs no extra approval. Never use git to undo or bypass the host\u2019s Keep, Reject, or checkpoint flow.';

export const MODE_DESCRIPTORS: readonly ModeDescriptor[] = [
  {
    mode: 'agent',
    label: 'Agent',
    description: 'The agent acts on the workspace.',
    enforcement: 'act',
    developerInstructions:
      `Work in Agent mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Act on the workspace. If you are executing an approved plan, work its steps in order and report each step as it changes by writing one checkbox line on its own line, repeating that step\u2019s text exactly: "- [~] ..." when you start it and "- [x] ..." when you finish it ("- [-] ..." if it was denied). Write that line at the moment the status changes, before you continue, so the plan document and the todo list update while you work. Keep going through every remaining step. Do not stop to ask whether to continue. Do not rewrite the plan prose. ${AGENT_DEFINITION_OF_DONE} ${ARTIFACT_HOME} ${GIT_SAFETY} ${REPLY_SHAPE} ${REPLY_CLOSE} ${QUESTION_BLOCK} Ask only when you cannot look the answer up yourself.`
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'The agent writes a plan document that ends in a todo list, and waits for approval before changing anything.',
    enforcement: 'act',
    developerInstructions:
      `Work in Plan mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Investigate what the task requires, then answer with one markdown plan: a title, the plan body (approach, files, and risks), and a final "## Steps" section whose items are a checkbox list, one step per line ("- [ ] ..."). Do not implement the plan. If a plan already exists, leave that document unchanged unless the user asked you to update or revise it. When the user answers your questions, rewrite that same document so the body, a "## Decisions" section, and the steps reflect those answers. The selected permission level controls which workspace actions are available. Present the plan and wait for the user to approve it before implementing its steps. If you need a decision before the plan can be written, do not write the plan yet. ${PLAN_DEFINITION_OF_DONE} ${ARTIFACT_HOME} ${GIT_SAFETY} ${REPLY_SHAPE} ${REPLY_CLOSE} ${QUESTION_BLOCK}`
  },
  {
    mode: 'ask',
    label: 'Ask',
    description: 'The agent only answers questions and does not change anything.',
    enforcement: 'answer-only',
    developerInstructions:
      `Work in Ask mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Answer the user\u2019s questions using what you can read. Do not run commands, edit files, write or revise the plan document, or propose changes to the workspace; if the user asks you to make a change, explain that Ask mode only answers questions and that the host can switch to Agent or Plan. Do not emit a sidecode-question block. ${REPLY_SHAPE} ${REPLY_CLOSE}`
  }
];

/** The descriptor for a mode, defaulting to `agent`'s copy. */
export function modeDescriptor(mode: DefaultMode): ModeDescriptor {
  return MODE_DESCRIPTORS.find((entry) => entry.mode === mode) ?? MODE_DESCRIPTORS[0];
}

/** Every mode the settings screen offers, in presentation order. */
export { DEFAULT_MODES };

/** Whether a value is one of the modes this module knows. */
export function isDefaultMode(value: unknown): value is DefaultMode {
  return typeof value === 'string' && (DEFAULT_MODES as readonly string[]).includes(value);
}

/**
 * The `developerInstructions` for a mode.
 *
 * Agent and Plan get the detected frontend checklist appended, because they
 * act on UI. Ask answers without acting, so its instructions stay exactly as
 * written. The stored descriptor text is never modified.
 */
export function modeInstructions(mode: DefaultMode, frontendStack?: FrontendStack): string | undefined {
  const descriptor = modeDescriptor(mode);
  const base = descriptor.developerInstructions;
  if (!base || (descriptor.mode !== 'agent' && descriptor.mode !== 'plan') || !frontendStack) {
    return base;
  }
  const checklist = frontendChecklist(frontendStack);
  return checklist ? `${base}\n\n${checklist}` : base;
}

/** What a mode enforces on the workspace. */
export function modeEnforcement(mode: DefaultMode): ModeEnforcement {
  return modeDescriptor(mode).enforcement;
}

/**
 * True when a mode must run the workspace read-only. Ask forces it; Plan leaves
 * the chosen permission level in force.
 */
export function modeForcesReadOnly(mode: DefaultMode): boolean {
  return modeEnforcement(mode) !== 'act';
}

/**
 * True when a mode must refuse to run commands or change files at all. Ask
 * permits neither a command nor a write.
 */
export function modeRefusesTools(mode: DefaultMode): boolean {
  return modeEnforcement(mode) === 'answer-only';
}

/**
 * True when a mode must refuse every approval the agent raises. Ask runs in a
 * read-only sandbox, so an approval request is by definition the
 * agent asking to escalate past read-only — a route to a write. Refusing it is
 * the enforcement half of the mode; the prompt is never trusted to decline on
 * its own.
 */
export function modeRefusesApprovals(mode: DefaultMode): boolean {
  return modeForcesReadOnly(mode);
}

/** The plain explanation a user and the agent receive when a mode refuses. */
export function modeRefusalReason(mode: DefaultMode): string {
  if (mode === 'ask') {
    return 'Ask mode only answers questions, so this request was refused. Switch to Agent mode to run it.';
  }
  if (mode === 'plan') {
    return 'This action is unavailable at the selected permission level.';
  }
  return 'This request was refused.';
}

/**
 * The permission level a turn actually runs at, after mode enforcement. Ask
 * forces read-only; Plan and Agent honor the caller-selected level.
 */
export function effectivePermissionLevel(
  mode: DefaultMode,
  selected: PermissionLevel
): PermissionLevel {
  if (modeForcesReadOnly(mode)) {
    return 'read-only';
  }
  return selected;
}

/**
 * Modes a backend can honour. A backend reports its own support; this helper
 * only filters the shared set, so an unknown value can never be reported as
 * supported.
 */
export function supportedModes(modes: readonly DefaultMode[]): readonly DefaultMode[] {
  return DEFAULT_MODES.filter((mode) => modes.includes(mode));
}

/**
 * Whether a backend can honour a mode. The registry uses this so a saved mode
 * the current backend cannot serve degrades to `agent` rather than being sent.
 */
export function backendSupportsMode(modes: readonly DefaultMode[], mode: DefaultMode): boolean {
  return modes.includes(mode);
}
