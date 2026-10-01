/**
 * A single diagnostic sink for the Codex adapter.
 *
 * Diagnostic, not user-facing: it exists so a spawn-argument drift ("which form
 * started?") is visible in an output channel instead of being hidden behind a
 * silent `unavailable`. It must never receive a credential or a raw stderr line,
 * so callers pass only fixed, non-secret sentences.
 *
 * Default is a no-op, which keeps the adapter host-free in tests. The extension
 * installs the real output channel at activation.
 */

export type DiagnosticSink = (message: string) => void;

let sink: DiagnosticSink | undefined;

/** Install the process-wide diagnostic sink (called once at activation). */
export function setDiagnosticSink(next: DiagnosticSink | undefined): void {
  sink = next;
}

/** Emit one diagnostic line, or nothing when no sink is installed. */
export function logDiagnostic(message: string): void {
  sink?.(message);
}
