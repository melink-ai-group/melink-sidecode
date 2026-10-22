/**
 * Advisory diagnostics sweep over the files a turn changed.
 *
 * The host waits DOUBLE_CHECK_SETTLE_MS before calling this so VS Code has
 * published fresh diagnostics, then injects its own reader. The aggregation is
 * pure: a failed read is skipped and never fails the turn.
 */

export const DOUBLE_CHECK_SETTLE_MS = 1500;
export const DOUBLE_CHECK_NAME_CAP = 3;

export type DoubleCheckStatus = 'clean' | 'issues' | 'none';

export interface DoubleCheckDiagnostic {
  /** VS Code's DiagnosticSeverity.Error is 0; the host may map it to a label. */
  severity: 'error' | 'warning' | 'info' | 'hint' | number | string;
}

export type ReadDiagnostics = (path: string) => readonly DoubleCheckDiagnostic[];

export interface DoubleCheckResult {
  status: DoubleCheckStatus;
  fileCount: number;
  errorCount: number;
  names: string[];
}

export interface DoubleCheckNotice {
  level: 'info' | 'warning';
  message: string;
}

export function collectDoubleCheck(
  files: readonly string[],
  readDiagnostics: ReadDiagnostics
): DoubleCheckResult {
  const names: string[] = [];
  let fileCount = 0;
  let errorCount = 0;

  for (const path of new Set(files)) {
    let diagnostics: readonly DoubleCheckDiagnostic[];
    try {
      diagnostics = readDiagnostics(path);
    } catch {
      continue;
    }
    if (!Array.isArray(diagnostics)) {
      continue;
    }
    fileCount += 1;
    const errors = diagnostics.filter(isError).length;
    if (errors > 0) {
      errorCount += errors;
      names.push(path);
    }
  }

  const capped = names.slice(0, DOUBLE_CHECK_NAME_CAP);
  return {
    status: errorCount > 0 ? 'issues' : fileCount > 0 ? 'clean' : 'none',
    fileCount,
    errorCount,
    names: capped
  };
}

export function doubleCheckNotice(result: DoubleCheckResult): DoubleCheckNotice | undefined {
  if (result.status === 'none') {
    return undefined;
  }
  const files = `${result.fileCount} changed ${result.fileCount === 1 ? 'file' : 'files'}`;
  if (result.status === 'clean') {
    return { level: 'info', message: 'No errors found in the checked files.' };
  }
  const errors = `${result.errorCount} ${result.errorCount === 1 ? 'error' : 'errors'}`;
  const names = result.names.join(', ');
  return {
    level: 'warning',
    message: `${errors} in ${files}: ${names}. Open Problems for details.`
  };
}

function isError(diagnostic: DoubleCheckDiagnostic): boolean {
  return (
    diagnostic.severity === 0 ||
    (typeof diagnostic.severity === 'string' &&
      diagnostic.severity.toLowerCase() === 'error')
  );
}
