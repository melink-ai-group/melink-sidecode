import type { SettingsSnapshot } from '../protocol';

/**
 * The opencode runtime status as the settings screen renders it.
 *
 * Kept pure and separate from the component so the three-state mapping is
 * unit-testable. Every Ollama Cloud, Ollama Local and OpenCode Zen turn uses
 * this CLI, so there is no disabled state: the host-reported `detected` /
 * `missing` / `not-runnable` map onto three distinct visual tones.
 */
export type RuntimeTone = 'detected' | 'missing' | 'not-runnable';

export interface RuntimeView {
  tone: RuntimeTone;
  label: string;
  /** Present only for the detected state. */
  version?: string;
}

export interface OpencodeRuntimeViewOptions {
  /** Draft CLI source; defaults to the saved `cliSource`. */
  source?: 'local' | 'bundled';
}

export function opencodeRuntimeView(
  opencode: SettingsSnapshot['opencode'],
  options: OpencodeRuntimeViewOptions = {}
): RuntimeView {
  const source = options.source ?? opencode.cliSource;
  const probe = source === 'bundled' ? opencode.bundled : opencode.local;
  if (probe.status === 'detected') {
    return {
      tone: 'detected',
      label: source === 'bundled' ? 'Bundled opencode detected' : 'opencode detected',
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
