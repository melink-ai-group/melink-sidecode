import { DEFAULT_MODES, type DefaultMode, type PermissionLevel } from './types.ts';

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
const QUESTION_BLOCK =
  'When you need a decision from the user, stop and end your reply with one fenced sidecode-question block and do not continue until the answers arrive. The block is JSON of the form {"questions":[{"prompt":"...","options":["preferred answer","next-best answer"]}]}. Put the preferred answer first. The host adds a custom-message choice, so do not add one yourself.';

export const MODE_DESCRIPTORS: readonly ModeDescriptor[] = [
  {
    mode: 'agent',
    label: 'Agent',
    description: 'The agent acts on the workspace.',
    enforcement: 'act',
    developerInstructions:
      `Work in Agent mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Act on the workspace. If you are executing an approved plan, work its steps in order and report progress with checkbox lines that repeat each step\u2019s text exactly ("- [~] ..." while it is in progress, "- [x] ..." when it is done, "- [-] ..." if it was denied). Do not rewrite the plan prose. ${QUESTION_BLOCK} Ask only when you cannot look the answer up yourself.`
  },
  {
    mode: 'plan',
    label: 'Plan',
    description: 'The agent writes a plan document that ends in a todo list, and waits for approval before changing anything.',
    enforcement: 'act',
    developerInstructions:
      `Work in Plan mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Investigate what the task requires, then answer with one markdown plan: a title, the plan body (approach, files, and risks), and a final "## Steps" section whose items are a checkbox list, one step per line ("- [ ] ..."). Do not implement the plan. If a plan already exists, leave that document unchanged unless the user asked you to update or revise it. The selected permission level controls which workspace actions are available. Present the plan and wait for the user to approve it before implementing its steps. If you need a decision before the plan can be written, do not write the plan yet. ${QUESTION_BLOCK}`
  },
  {
    mode: 'ask',
    label: 'Ask',
    description: 'The agent only answers questions and does not change anything.',
    enforcement: 'answer-only',
    developerInstructions:
      'Work in Ask mode. The available modes are Agent (act on the workspace), Plan (investigate and write a plan document, revising it only when the user asks), and Ask (answer questions without acting). Answer the user\u2019s questions using what you can read. Do not run commands, edit files, write or revise the plan document, or propose changes to the workspace; if the user asks you to make a change, explain that Ask mode only answers questions and that the host can switch to Agent or Plan. Do not emit a sidecode-question block.'
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

/** The `developerInstructions` for a mode. */
export function modeInstructions(mode: DefaultMode): string | undefined {
  return modeDescriptor(mode).developerInstructions;
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
