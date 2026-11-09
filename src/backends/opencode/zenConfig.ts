/**
 * Per-turn OpenCode config for OpenCode Zen models.
 *
 * Uses a namespaced provider id so a user's `opencode auth login` for the
 * built-in `opencode` provider cannot override the SecretStorage Zen key.
 * Model refs stay `melink-opencode-zen/<id>`; Zen's OpenAI-compatible gateway
 * is `https://opencode.ai/zen/v1`.
 */

import type {
  DefaultMode,
  ModelCapabilities,
  ModelSettingOverrides,
  PermissionLevel,
  ThinkingLevel
} from '../types.ts';
import { isKnown } from '../capabilities.ts';
import { isDefaultMode } from '../modes.ts';
import type { BrowserCommand } from '../../browser/config.ts';
import { browserPermissionKeys, mergeOpencodeMcp } from '../../browser/config.ts';
import { AST_GREP_REPLACE_PERMISSION } from '../../skills/opencodeMcp.ts';
import {
  astGrepReplacePermission,
  opencodeAgentConfig,
  opencodeAgentForMode,
  opencodeAgentSuffix,
  opencodePermission,
  opencodeReasoningEffort,
  outputLimitFor,
  type OpencodeConfigResult
} from './config.ts';

/** Namespaced Zen provider so SecretStorage stays authoritative. */
export const ZEN_PROVIDER_ID = 'melink-opencode-zen';

/** Env var the generated Zen provider reads (never inlined into config). */
export const ZEN_API_KEY_ENV = 'OPENCODE_API_KEY';

/** OpenAI-compatible Zen gateway. */
export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

export interface ZenConfigInput {
  modelIds: readonly string[];
  modelId: string;
  settings?: ModelSettingOverrides;
  capabilities?: ModelCapabilities;
  mode: DefaultMode;
  permissionLevel: PermissionLevel;
  browser?: BrowserCommand;
  skillMcp?: Record<string, unknown>;
  skillPermissions?: Record<string, 'allow' | 'ask' | 'deny'>;
  astGrepSkill?: boolean;
  /** Test seam only; production generates a fresh random nonce per turn. */
  agentNonce?: string;
}

/**
 * Build the per-turn Zen config. Model ids are the live Zen catalog (or the
 * free subset); the selected model carries limit/reasoning when known.
 */
export function buildZenOpencodeConfig(input: ZenConfigInput): OpencodeConfigResult {
  const {
    modelIds,
    modelId,
    settings,
    capabilities,
    mode,
    permissionLevel,
    browser,
    skillMcp,
    skillPermissions,
    astGrepSkill
  } = input;
  const resolvedMode: DefaultMode = isDefaultMode(mode) ? mode : 'agent';
  const nonce = opencodeAgentSuffix(input.agentNonce);

  const models: Record<string, unknown> = {};
  for (const id of modelIds) {
    models[id] = { name: id, tool_call: true };
  }

  const contextApplied = isKnown(settings?.contextWindow ?? 'unknown')
    ? (settings?.contextWindow as number)
    : undefined;
  const capabilitiesReasoning = capabilities?.thinking.supported;
  const reasoningKnown = capabilitiesReasoning !== undefined && isKnown(capabilitiesReasoning);
  const reasoningSupported = reasoningKnown && (capabilitiesReasoning as ThinkingLevel[]).length > 0;

  const requestedThinking = settings?.thinking;
  const reasoningApplied =
    reasoningSupported && requestedThinking !== undefined
      ? opencodeReasoningEffort(requestedThinking)
      : undefined;
  const reasoningUnsupported =
    reasoningKnown && !reasoningSupported && requestedThinking !== undefined && requestedThinking !== 'off';

  const selected: Record<string, unknown> = { name: modelId, tool_call: true };
  if (capabilities?.inputModalities && capabilities.inputModalities !== 'unknown') {
    selected.modalities = { input: capabilities.inputModalities, output: ['text'] };
  }
  if (contextApplied !== undefined) {
    selected.limit = { context: contextApplied, output: outputLimitFor(contextApplied) };
  }
  if (reasoningKnown) {
    selected.reasoning = reasoningSupported;
  }
  if (reasoningApplied !== undefined) {
    selected.options = { reasoningEffort: reasoningApplied };
  }
  models[modelId] = selected;

  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [ZEN_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenCode Zen',
        env: [ZEN_API_KEY_ENV],
        options: {
          baseURL: ZEN_BASE_URL
        },
        models
      }
    },
    small_model: `${ZEN_PROVIDER_ID}/${modelId}`,
    share: 'disabled',
    autoupdate: false,
    permission: {
      ...opencodePermission(permissionLevel, resolvedMode),
      ...(browser ? browserPermissionKeys() : {}),
      ...(skillPermissions ?? {}),
      ...(astGrepSkill
        ? { [AST_GREP_REPLACE_PERMISSION]: astGrepReplacePermission(permissionLevel, resolvedMode) }
        : {})
    }
  };
  const mcp = mergeOpencodeMcp(skillMcp, browser);
  if (mcp) {
    config.mcp = mcp;
  }
  config.agent = opencodeAgentConfig(
    resolvedMode,
    config.permission as Record<string, 'allow' | 'ask' | 'deny'>,
    nonce
  );

  return {
    config,
    modelRef: `${ZEN_PROVIDER_ID}/${modelId}`,
    agent: opencodeAgentForMode(resolvedMode, nonce),
    contextApplied,
    reasoningApplied,
    reasoningUnsupported
  };
}
