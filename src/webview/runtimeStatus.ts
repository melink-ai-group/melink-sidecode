import type { SettingsSnapshot } from '../protocol';

/**
 * The opencode runtime status as the settings screen renders it.
 *
 * Kept pure and separate from the component so the three-state mapping is
 * unit-testable: `disabled` short-circuits (an off runtime never shows a stale
 * detected/missing result), and the host-reported `detected` / `missing` /
 * `not-runnable` map onto the three distinct visual tones.
 */
export type RuntimeTone = 'detected' | 'missing' | 'not-runnable' | 'disabled';

export interface RuntimeView {
  tone: RuntimeTone;
  label: string;
  /** Present only for the detected state. */
  version?: string;
}

export interface OpencodeRuntimeViewOptions {
  /** Draft CLI source; defaults to the saved `cliSource`. */
  source?: 'local' | 'bundled';
  /** Draft enabled flag; defaults to the saved `enabled`. */
  enabled?: boolean;
}

export function opencodeRuntimeView(
  opencode: SettingsSnapshot['opencode'],
  options: OpencodeRuntimeViewOptions = {}
): RuntimeView {
  const enabled = options.enabled ?? opencode.enabled;
  // When the Ollama nested runtime is off, still report the binary status for
  // the CLI tab / OpenCode Zen — they share this install regardless of the flag.
  const source = options.source ?? opencode.cliSource;
  const probe = source === 'bundled' ? opencode.bundled : opencode.local;
  if (probe.status === 'detected') {
    return {
      tone: 'detected',
      label: !enabled
        ? source === 'bundled'
          ? 'Bundled opencode detected (Ollama uses the direct adapter)'
          : 'opencode detected (Ollama uses the direct adapter)'
        : source === 'bundled'
          ? 'Bundled opencode detected'
          : 'opencode detected',
      ...(probe.version ? { version: probe.version } : {})
    };
  }
  if (probe.status === 'missing') {
    return {
      tone: 'missing',
      label:
        source === 'bundled'
          ? 'Bundled CLI not found. Install opencode to download it.'
          : 'Not found. Install opencode, or set the CLI path.'
    };
  }
  return { tone: 'not-runnable', label: 'Found but not runnable. Check the path or permissions.' };
}
