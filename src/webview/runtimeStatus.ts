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

export function opencodeRuntimeView(opencode: SettingsSnapshot['opencode']): RuntimeView {
  if (!opencode.enabled) {
    return { tone: 'disabled', label: 'Runtime off. The direct Ollama adapter runs turns.' };
  }
  if (opencode.status === 'detected') {
    return {
      tone: 'detected',
      label: 'opencode detected',
      ...(opencode.version ? { version: opencode.version } : {})
    };
  }
  if (opencode.status === 'missing') {
    return { tone: 'missing', label: 'Not found. Check the path or install the opencode CLI.' };
  }
  return { tone: 'not-runnable', label: 'Found but not runnable. Check the path or permissions.' };
}
