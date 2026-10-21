import type { SkillCliSnapshot } from '../../protocol';

/**
 * Pure read-model decisions for one Skills panel.
 *
 * `checked` reads the saved application-scoped `enabled` flag, not
 * `connected`: a skill can be enabled while the MCP handshake is still
 * settling, and a reload must not flip the checkbox off. The chip is the place
 * that reports "still needs setup".
 */

export type SkillId = 'zvecGrep' | 'astGrep';
export type SkillChipTone = 'ready' | 'needs' | 'missing' | 'index' | 'error' | 'working';

export interface SkillChipState {
  label: string;
  tone: SkillChipTone;
}

export function skillChecked(input: {
  pending: boolean;
  requested?: boolean;
  snapshot: Pick<SkillCliSnapshot, 'enabled'>;
}): boolean {
  return input.pending ? input.requested === true : input.snapshot.enabled;
}

export function skillChip(input: {
  skill: SkillId;
  pending: boolean;
  snapshot: Pick<SkillCliSnapshot, 'enabled' | 'connected' | 'cli' | 'status' | 'index' | 'detail'>;
}): SkillChipState {
  if (input.pending) {
    return { label: 'Working...', tone: 'working' };
  }
  const snapshot = input.snapshot;
  if (snapshot.cli === 'missing' || snapshot.status === 'missing') {
    return { label: 'Missing binary', tone: 'missing' };
  }
  if (input.skill === 'zvecGrep' && snapshot.enabled && snapshot.index === 'missing') {
    return { label: 'Index missing', tone: 'index' };
  }
  if (snapshot.connected) {
    return { label: 'Ready', tone: 'ready' };
  }
  if (snapshot.enabled && snapshot.detail) {
    return { label: 'Error', tone: 'error' };
  }
  return { label: 'Needs setup', tone: 'needs' };
}

export function chipClass(tone: SkillChipTone): string {
  switch (tone) {
    case 'ready':
      return 'chip chip--stored';
    case 'needs':
    case 'working':
      return 'chip chip--signedin';
    case 'index':
      return 'chip chip--warning';
    case 'error':
    case 'missing':
      return 'chip chip--missing';
  }
}

export function skillStatusText(input: {
  skill: SkillId;
  pending: boolean;
  requested?: boolean;
  snapshot: Pick<
    SkillCliSnapshot,
    'enabled' | 'connected' | 'cli' | 'status' | 'detail' | 'index'
  >;
}): string {
  if (input.pending) {
    return input.requested
      ? 'Installing and connecting to OpenCode. This can take a moment.'
      : 'Disconnecting from OpenCode.';
  }
  const snapshot = input.snapshot;
  if (snapshot.cli === 'missing' || snapshot.status === 'missing') {
    return 'The CLI is not installed. Install it, then turn the skill on.';
  }
  if (input.skill === 'zvecGrep' && snapshot.enabled && snapshot.index === 'missing') {
    return 'Needs a workspace index. Press Build index to use semantic search.';
  }
  if (snapshot.connected) {
    return 'Ready. A new OpenCode session uses it.';
  }
  if (snapshot.enabled && snapshot.detail) {
    return snapshot.detail;
  }
  if (snapshot.enabled) {
    return 'On, but OpenCode is not connected yet. Press Test for the reason.';
  }
  if (snapshot.status === 'detected') {
    return 'Installed. Turn this on to connect it to OpenCode.';
  }
  return 'Not runnable. Check the path, then press Test.';
}
