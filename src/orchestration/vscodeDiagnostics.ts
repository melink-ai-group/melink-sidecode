import * as vscode from 'vscode';
import type { DoubleCheckDiagnostic } from './doubleCheck.ts';

/** The injectable slice of VS Code the binding needs; tests supply a fake. */
export interface DiagnosticsHost {
  uri(absPath: string): unknown;
  read(uri: unknown): readonly { severity: number }[];
  errorSeverity: number;
}

/** The thin VS Code binding for the double-check sweep; the core stays pure. */
export function readFileDiagnostics(
  absPath: string,
  host: DiagnosticsHost = {
    uri: (path) => vscode.Uri.file(path),
    read: (uri) => vscode.languages.getDiagnostics(uri as vscode.Uri),
    errorSeverity: vscode.DiagnosticSeverity.Error
  }
): readonly DoubleCheckDiagnostic[] {
  return host
    .read(host.uri(absPath))
    .filter((diagnostic) => diagnostic.severity === host.errorSeverity)
    .map(() => ({ severity: 'error' }));
}
