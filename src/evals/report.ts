import type { ScenarioResult } from './types.ts';

export interface EvalReportMeta {
  /** ISO timestamp of the run. Only the report carries a clock value. */
  date: string;
  /** Base commit the run was measured on (report metadata only). */
  baseCommit: string;
  /** Worktree state at run time, so a baseline is honest about uncommitted work. */
  worktree?: string;
  /** Exact command that produced the report. */
  command: string;
}

function resultLabel(result: ScenarioResult): string {
  return result.score.pass ? 'PASS' : 'FAIL';
}

/**
 * Render a markdown report for a completed run. Pure: all run metadata is
 * passed in, so tests can pin the output.
 */
export function renderReport(
  results: readonly ScenarioResult[],
  meta: EvalReportMeta
): string {
  const passed = results.filter((result) => result.score.pass).length;
  const rows = results.map(
    (result) =>
      `| ${result.scenarioId} | ${result.score.plan} | ${result.score.tools} | ${result.score.total} | ${resultLabel(result)} |`
  );
  const details = results
    .filter((result) => !result.score.pass && result.detail)
    .map((result) => `### ${result.scenarioId}\n\n\`\`\`text\n${result.detail}\n\`\`\``);

  return [
    '# Golden-scenario eval report',
    '',
    `- Date: ${meta.date}`,
    `- Base commit: \`${meta.baseCommit}\``,
    ...(meta.worktree ? [`- Worktree: ${meta.worktree}`] : []),
    `- Command: \`${meta.command}\``,
    '- Mode: offline fixture scoring, no model or provider call',
    '- Method: each prompt is built from the mode instructions, fixture context, and request and recorded for reproducibility; scores come only from the committed golden trajectories, not a live model',
    '',
    '## Summary',
    '',
    '| Scenario | Plan | Tools | Total | Result |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `**${passed}/${results.length} scenarios passed.**`,
    '',
    '## Scoring',
    '',
    '- Plan score: share of required plan patterns matched, minus 25 per forbidden pattern (0-100).',
    '- Tool score: share of required tool requirements met, minus 25 per forbidden call (0-100).',
    '- Total: rounded average of plan and tools. A scenario passes only when nothing required is missing and no forbidden item occurred.',
    '',
    ...(details.length === 0 ? [] : ['## Failure details', '', ...details, '']),
    '## Reproduction',
    '',
    '```sh',
    'npm install',
    meta.command,
    '```',
    '',
    'The run is deterministic: it scores the committed trajectories in `src/evals/scenarios.ts` and never contacts a provider.',
    '',
    '## Limitations',
    '',
    'This is a golden-trajectory eval, not a live model evaluation. It checks whether the committed reference behaviour satisfies the scenario expectations and whether the scorer catches regressions in those trajectories. It does not measure a running model, latency, or cost. There is no live mode; adding one would be opt-in and is not part of this baseline.',
    ''
  ].join('\n');
}
