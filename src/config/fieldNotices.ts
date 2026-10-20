import { fieldSaveOutcome } from './settingsScope.ts';
import { WORKSPACE_SAVE_REFUSED_MESSAGE } from './trust.ts';

/**
 * The trust-sensitive fields the settings screen exposes, and the notice each
 * one shows when a "Save to workspace" could not be honoured.
 *
 * Nine fields decide where a credential is sent, which binary is spawned, or
 * what the permission default is. They are read from the user's own settings
 * only, so a "Save to workspace" writes them to the user settings instead.
 * The value *is* persisted, so the message is a notice rather than an error —
 * but it must appear on every one of the nine fields. A field that silently
 * saved somewhere else than the button said is a lie.
 *
 * The mapping lives here, host-free, so the screen and the tests read the
 * same list: a trust-sensitive field that is missing from this table fails
 * the test rather than quietly saving to the wrong scope.
 */

/** The nine trust-sensitive field names used by `SettingsPatch`. */
export const TRUST_SENSITIVE_FIELDS = [
  'ollamaBaseUrl',
  'opencodeCliSource',
  'opencodePath',
  'codexPath',
  'permissionLevel',
  'zvecGrepCliSource',
  'zvecGrepPath',
  'astGrepCliSource',
  'astGrepPath'
] as const;

/** One of the trust-sensitive field names. */
export type TrustSensitiveField = (typeof TRUST_SENSITIVE_FIELDS)[number];

/** The setting key each trust-sensitive field writes. */
export const TRUST_SENSITIVE_FIELD_KEYS: Readonly<Record<TrustSensitiveField, string>> = {
  ollamaBaseUrl: 'melink.ollama.baseUrl',
  opencodeCliSource: 'melink.ollama.opencode.cliSource',
  opencodePath: 'melink.ollama.opencode.path',
  codexPath: 'melink.codex.path',
  permissionLevel: 'melink.defaults.permissionLevel',
  zvecGrepCliSource: 'melink.skills.zvecGrep.cliSource',
  zvecGrepPath: 'melink.skills.zvecGrep.path',
  astGrepCliSource: 'melink.skills.astGrep.cliSource',
  astGrepPath: 'melink.skills.astGrep.path'
};

/**
 * The notice to render on one field, or `undefined` when the field has none.
 *
 * The host is the authority: it echoes the notice it actually applied (only
 * for a field that really was redirected), so this reads the host's map and
 * adds nothing of its own. The map is keyed by the `SettingsPatch` field
 * name, so every trust-sensitive field is covered by construction rather than
 * by remembering to add a block in the screen.
 */
export function noticeForField(
  field: string,
  notices: Partial<Record<string, string>> | undefined
): string | undefined {
  return notices?.[field];
}

/**
 * The notice the host produces for a trust-sensitive field when a workspace
 * save was asked for.
 *
 * Exposed so the screen's behaviour can be asserted without a host: the
 * outcome is the same seam the settings service uses to decide where the
 * value is written.
 */
export function trustSensitiveNotice(field: TrustSensitiveField): string {
  const outcome = fieldSaveOutcome(TRUST_SENSITIVE_FIELD_KEYS[field], 'workspace');
  return outcome.notice ?? WORKSPACE_SAVE_REFUSED_MESSAGE;
}
