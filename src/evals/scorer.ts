import type {
  EvalScenario,
  EvalScore,
  EvalToolCall,
  EvalTrajectory,
  ScenarioResult
} from './types.ts';

const EXCERPT_LIMIT = 320;
const FORBIDDEN_PENALTY = 25;

function compile(source: string): RegExp {
  return new RegExp(source, 'i');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  const oneLine = normalize(text);
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function describeTool(call: EvalToolCall): string {
  return call.input ? `${call.name}(${call.input})` : call.name;
}

/** Whether a tool call satisfies `name` or `name:input-needle` (case-insensitive). */
export function toolSatisfies(call: EvalToolCall, requirement: string): boolean {
  const separator = requirement.indexOf(':');
  const name = separator === -1 ? requirement : requirement.slice(0, separator);
  const needle = separator === -1 ? '' : requirement.slice(separator + 1);
  if (call.name.toLowerCase() !== name.toLowerCase()) {
    return false;
  }
  if (!needle) {
    return true;
  }
  return (call.input ?? '').toLowerCase().includes(needle.toLowerCase());
}

interface PlanPart {
  score: number;
  missing: string[];
  violations: string[];
}

interface ToolPart {
  score: number;
  missing: string[];
  violations: string[];
}

function scorePlan(scenario: EvalScenario, trajectory: EvalTrajectory): PlanPart {
  const required = scenario.expectedPlan.required;
  const forbidden = scenario.expectedPlan.forbidden ?? [];
  const missing: string[] = [];
  const violations: string[] = [];
  let matched = 0;

  for (const pattern of required) {
    if (compile(pattern).test(trajectory.plan)) {
      matched += 1;
    } else {
      missing.push(`plan: ${pattern}`);
    }
  }

  let forbiddenHits = 0;
  for (const pattern of forbidden) {
    if (compile(pattern).test(trajectory.plan)) {
      forbiddenHits += 1;
      violations.push(`plan: ${pattern}`);
    }
  }

  const ratio = required.length === 0 ? 1 : matched / required.length;
  const score = Math.max(0, Math.round(ratio * 100) - forbiddenHits * FORBIDDEN_PENALTY);
  return { score, missing, violations };
}

function scoreTools(scenario: EvalScenario, trajectory: EvalTrajectory): ToolPart {
  const calls = trajectory.toolCalls;
  const missing: string[] = [];
  const violations: string[] = [];
  let matched = 0;

  for (const requirement of scenario.requiredTools) {
    if (calls.some((call) => toolSatisfies(call, requirement))) {
      matched += 1;
    } else {
      missing.push(`tool: ${requirement}`);
    }
  }

  let forbiddenHits = 0;
  for (const requirement of scenario.forbiddenTools) {
    if (calls.some((call) => toolSatisfies(call, requirement))) {
      forbiddenHits += 1;
      violations.push(`tool: ${requirement}`);
    }
  }

  const ratio = scenario.requiredTools.length === 0 ? 1 : matched / scenario.requiredTools.length;
  const score = Math.max(0, Math.round(ratio * 100) - forbiddenHits * FORBIDDEN_PENALTY);
  return { score, missing, violations };
}

/** Bounded, single-line plan text for failure output and result records. */
export function boundedPlanExcerpt(plan: string): string {
  return truncate(plan, EXCERPT_LIMIT);
}

function buildExcerpt(trajectory: EvalTrajectory): string {
  const plan = `plan: ${truncate(trajectory.plan, EXCERPT_LIMIT)}`;
  const tools =
    trajectory.toolCalls.length === 0
      ? 'tools: (none)'
      : `tools: ${trajectory.toolCalls.map(describeTool).join(', ')}`;
  return truncate(`${plan} | ${tools}`, EXCERPT_LIMIT);
}

/** Score one trajectory against one scenario. Pure and deterministic. */
export function scoreTrajectory(
  scenario: EvalScenario,
  trajectory: EvalTrajectory
): EvalScore {
  const plan = scorePlan(scenario, trajectory);
  const tools = scoreTools(scenario, trajectory);
  const missing = [...plan.missing, ...tools.missing];
  const violations = [...plan.violations, ...tools.violations];
  return {
    plan: plan.score,
    tools: tools.score,
    total: Math.round((plan.score + tools.score) / 2),
    pass: missing.length === 0 && violations.length === 0,
    missing,
    violations,
    excerpt: buildExcerpt(trajectory)
  };
}

/** Actionable failure text with scenario, expectations, actuals, gaps, and scores. */
export function formatFailure(result: ScenarioResult): string {
  const { score } = result;
  const expectedPlan = result.expectedPlan.map((pattern) => `/${pattern}/`).join(', ');
  const expectedTools = result.expectedTools.join(', ') || '(none)';
  const actualTools = result.actualTools.join(', ') || '(none)';
  const lines = [
    `[${result.scenarioId}] ${result.title}: FAIL (plan ${score.plan}/100, tools ${score.tools}/100, total ${score.total}/100)`,
    `Expected plan: ${expectedPlan}`,
    `Expected tools: ${expectedTools}`,
    `Actual plan: ${result.actualPlanExcerpt}`,
    `Actual tools: ${actualTools}`,
    'Missing:',
    ...(score.missing.length === 0 ? ['  (none)'] : score.missing.map((entry) => `  - ${entry}`)),
    'Violations:',
    ...(score.violations.length === 0
      ? ['  (none)']
      : score.violations.map((entry) => `  - ${entry}`))
  ];
  return lines.join('\n');
}
