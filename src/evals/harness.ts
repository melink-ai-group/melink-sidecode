import { modeInstructions } from '../backends/modes.ts';
import { boundedPlanExcerpt, formatFailure, scoreTrajectory } from './scorer.ts';
import { scenarios } from './scenarios.ts';
import type { EvalScenario, EvalToolCall, ScenarioResult } from './types.ts';

/**
 * Build the exact prompt the scenario stands for: the existing mode
 * instructions, the fixture context, and the user request. No provider is
 * called; the prompt is recorded so a failure is reproducible.
 */
export function buildPrompt(scenario: EvalScenario): string {
  const instructions = modeInstructions(scenario.mode) ?? '';
  return [
    instructions,
    `# Fixture context\n${scenario.context}`,
    `# Request\n${scenario.request}`
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

function formatTool(call: EvalToolCall): string {
  return call.input ? `${call.name}(${call.input})` : call.name;
}

/**
 * Run one scenario against its committed golden trajectory. Fully offline:
 * the trajectory is repository data, not model output.
 */
export function runScenario(scenario: EvalScenario): ScenarioResult {
  const prompt = buildPrompt(scenario);
  const score = scoreTrajectory(scenario, scenario.golden);
  const result: ScenarioResult = {
    scenarioId: scenario.id,
    title: scenario.title,
    score,
    expectedPlan: scenario.expectedPlan.required,
    expectedTools: scenario.requiredTools,
    actualPlanExcerpt: boundedPlanExcerpt(scenario.golden.plan),
    actualTools: scenario.golden.toolCalls.map(formatTool),
    prompt,
    detail: ''
  };
  if (!score.pass) {
    result.detail = formatFailure(result);
  }
  return result;
}

/** Run every scenario in fixed declaration order. */
export function runAll(): ScenarioResult[] {
  return scenarios.map((scenario) => runScenario(scenario));
}
