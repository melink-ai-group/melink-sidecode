import type { DefaultMode } from '../backends/types.ts';

/** One tool invocation in a scenario trajectory. Inputs are free-form text. */
export interface EvalToolCall {
  name: string;
  input?: string;
}

/** A committed, deterministic trajectory the scorer runs against a scenario. */
export interface EvalTrajectory {
  plan: string;
  toolCalls: readonly EvalToolCall[];
}

/** What a scenario's plan must and must not contain, as regex sources. */
export interface EvalPlanExpectation {
  required: readonly string[];
  forbidden?: readonly string[];
}

/**
 * A golden scenario: a fixed prompt fixture plus the trajectory and tool use a
 * correct answer is expected to produce.
 *
 * `requiredTools` entries are either a tool name (`approval`) or a name plus a
 * case-insensitive input needle (`read_file:package.json`).
 */
export interface EvalScenario {
  id: string;
  title: string;
  mode: DefaultMode;
  context: string;
  request: string;
  expectedPlan: EvalPlanExpectation;
  requiredTools: readonly string[];
  forbiddenTools: readonly string[];
  golden: EvalTrajectory;
}

/** Pure score for one trajectory. Plan and tools are scored separately. */
export interface EvalScore {
  /** 0-100; share of required plan patterns matched, minus forbidden hits. */
  plan: number;
  /** 0-100; share of required tools used, minus forbidden calls. */
  tools: number;
  /** Arithmetic mean of `plan` and `tools`, rounded. */
  total: number;
  /** True only when nothing required is missing and nothing forbidden occurred. */
  pass: boolean;
  /** `plan: <pattern>` / `tool: <requirement>` entries that were not satisfied. */
  missing: string[];
  /** `plan: <pattern>` / `tool: <requirement>` entries that were matched. */
  violations: string[];
  /** Bounded plan and tool summary for failure output. */
  excerpt: string;
}

/** One scenario's outcome, including the prompt it was evaluated against. */
export interface ScenarioResult {
  scenarioId: string;
  title: string;
  score: EvalScore;
  expectedPlan: readonly string[];
  expectedTools: readonly string[];
  /** Bounded actual plan, so failure output stays readable. */
  actualPlanExcerpt: string;
  /** Every actual tool call, never truncated. */
  actualTools: readonly string[];
  prompt: string;
  /** Empty when the scenario passed; actionable failure detail otherwise. */
  detail: string;
}
