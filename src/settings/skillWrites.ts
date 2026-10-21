/**
 * The writes one skill toggle performs.
 *
 * Kept host-free so the ordering rule can be tested: nothing is written until
 * the apply (install, MCP upsert, removal) has succeeded. Before T113 a failed
 * apply still left `cliSource` changed, so the next reload showed a source the
 * user never managed to apply.
 *
 * The enabled boolean is application-scoped (like the path it runs), so the
 * global write is effective even when a workspace has a stale override value.
 */

export type SkillId = 'zvecGrep' | 'astGrep';

export interface SkillToggleWritesInput {
  skill: SkillId;
  enabled: boolean;
  source: 'local' | 'bundled';
  path: string;
  /** The apply result; a failed apply writes nothing. */
  applied: boolean;
}

export interface SkillConfigWrite {
  key: string;
  value: unknown;
}

export function skillToggleWrites(input: SkillToggleWritesInput): SkillConfigWrite[] {
  if (!input.applied) {
    return [];
  }
  const fallback = input.skill === 'zvecGrep' ? 'zg' : 'ast-grep';
  const writes: SkillConfigWrite[] = [
    { key: `melink.skills.${input.skill}.cliSource`, value: input.source },
    {
      key: `melink.skills.${input.skill}.path`,
      value: input.path.trim() || fallback
    },
    { key: `melink.skills.${input.skill}`, value: input.enabled }
  ];
  if (input.skill === 'zvecGrep') {
    // Mirror the legacy key the turn resolver still falls back to.
    writes.push({ key: 'melink.ollama.opencode.zvecGrep', value: input.enabled });
  }
  return writes;
}
