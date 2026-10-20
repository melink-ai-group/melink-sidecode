import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { runAll } from './harness.ts';
import { renderReport } from './report.ts';

function invocation(reportPath?: string): string {
  return reportPath ? `npm run eval -- --report ${reportPath}` : 'npm run eval';
}

function readWorktreeState(): string {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    }).trim();
    return status ? 'uncommitted changes present' : 'clean';
  } catch {
    return 'unknown';
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function readBaseCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseReportPath(args: readonly string[]): string | undefined {
  const index = args.indexOf('--report');
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--report requires a file path');
  }
  return value;
}

function printTable(
  results: ReturnType<typeof runAll>
): void {
  const scenarioWidth = Math.max(
    'Scenario'.length,
    ...results.map((result) => result.scenarioId.length)
  );
  const header = [
    pad('Scenario', scenarioWidth),
    pad('Plan', 5),
    pad('Tools', 6),
    pad('Total', 6),
    'Result'
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const result of results) {
    console.log(
      [
        pad(result.scenarioId, scenarioWidth),
        pad(String(result.score.plan), 5),
        pad(String(result.score.tools), 6),
        pad(String(result.score.total), 6),
        result.score.pass ? 'PASS' : 'FAIL'
      ].join('  ')
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run eval [-- --report <path>]');
    console.log('Runs the offline golden-scenario eval and exits 1 on any failure.');
    return;
  }

  let reportPath: string | undefined;
  try {
    reportPath = parseReportPath(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const results = runAll();
  printTable(results);

  for (const result of results) {
    if (!result.score.pass && result.detail) {
      console.log('');
      console.log(result.detail);
    }
  }

  const passed = results.filter((result) => result.score.pass).length;
  console.log('');
  console.log(`${passed}/${results.length} scenarios passed.`);

  if (reportPath) {
    const target = isAbsolute(reportPath) ? reportPath : resolve(process.cwd(), reportPath);
    const report = renderReport(results, {
      date: new Date().toISOString(),
      baseCommit: readBaseCommit(),
      worktree: readWorktreeState(),
      command: invocation(reportPath)
    });
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, report, 'utf8');
      console.log(`Report written to ${target}`);
    } catch (error) {
      console.error(
        `Could not write report to ${target}: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 2;
      return;
    }
  }

  if (passed !== results.length) {
    process.exitCode = 1;
  }
}

main();
