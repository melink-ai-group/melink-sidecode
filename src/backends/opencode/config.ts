import { randomBytes } from 'node:crypto';
import type {
  DefaultMode,
  ModelCapabilities,
  ModelSettingOverrides,
  PermissionLevel,
  ThinkingLevel
} from '../types.ts';
import { isKnown } from '../capabilities.ts';
import { isDefaultMode, modeForcesReadOnly } from '../modes.ts';
import type { BrowserCommand } from '../../browser/config.ts';
import { browserPermissionKeys, mergeOpencodeMcp } from '../../browser/config.ts';

/**
 * The one home for the generated opencode config.
 *
 * Everything here is free of `vscode`, `node:child_process` and the filesystem,
 * so the mapping from our settings onto opencode's own vocabulary is
 * unit-testable and never writes anything. The one exception to determinism is
 * the per-turn agent nonce: it is random so a workspace cannot predefine,
 * disable, or replace the agent the turn runs under.
 *
 * ## Facts this module is built on (verified against opencode 1.19.x)
 *
 * - models.dev does define an `ollama-cloud` provider (OpenAI AI SDK adapter
 *   `@ai-sdk/openai-compatible`, `https://ollama.com/v1`, env `OLLAMA_API_KEY`).
 *   A **custom** provider entry is generated rather than relying on that
 *   models.dev id: a user who has run `opencode auth login` for it would have
 *   that stored credential silently override the token we supply, so the
 *   generated provider uses a namespaced id of our own (see below) to keep the
 *   SecretStorage token authoritative. The shape otherwise matches models.dev.
 * - The base URL setting defaults to `https://ollama.com`, so the generated
 *   provider points at the OpenAI-compatible `/v1` endpoint derived from it.
 * - `OPENCODE_CONFIG_CONTENT` is a documented inline runtime override, so the
 *   config is never written to the workspace and never checked in.
 * - The child reads its credential from the environment variable named by the
 *   provider's `env` list. The generated config declares only the variable name
 *   (`OLLAMA_API_KEY`), so the secret never appears in the config text, on disk,
 *   or in a log line; it reaches the child only through its environment at spawn
 *   time. The `{env:...}` template is deliberately not used: verified against the
 *   pinned version it resolves empty inside `OPENCODE_CONFIG_CONTENT`, whereas a
 *   declared provider `env` variable is read correctly.
 * - Model ids are passed through exactly as `/api/tags` returns them. The `models`
 *   map is generated per turn from that live list, so there is no hardcoded list.
 */

/**
 * The opencode provider id we define. Provider identity in the *sidebar* stays
 * Ollama; this id is internal to the generated config. It is deliberately
 * namespaced rather than `ollama`: a user who has run `opencode auth login` for
 * `ollama` would otherwise have that stored credential silently override the
 * token we supply through the environment. A distinct id makes the SecretStorage
 * token authoritative for this runtime.
 */
export const OPENCODE_PROVIDER_ID = 'melink-ollama-cloud';

/** The environment variable the generated config reads the token from. */
export const OPENCODE_API_KEY_ENV = 'OLLAMA_API_KEY';

/**
 * The local Ollama provider id and credential variable.
 *
 * A local server has no credential. OpenCode's OpenAI-compatible adapter still
 * expects the declared env variable to be present, so the adapter supplies a
 * fixed placeholder that is never a user secret and never sent anywhere that
 * validates it.
 */
export const OPENCODE_LOCAL_PROVIDER_ID = 'melink-ollama-local';
export const OPENCODE_LOCAL_API_KEY_ENV = 'OLLAMA_LOCAL_API_KEY';
export const LOCAL_OPENCODE_API_KEY = 'local-no-key';

/** The inline runtime override variable carrying the generated config. */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT';

/**
 * The custom agent name prefixes.
 *
 * Agent and Plan intentionally do not use opencode's built-in `build` agent: a
 * workspace `opencode.json` can set `agent.build.permission` and would otherwise
 * widen our permission block. Each turn appends a random nonce, so a workspace
 * cannot predefine the name, mark it `disable: true`, or attach a permissive
 * prompt to it.
 */
export const OPENCODE_AGENT_AGENT = 'melink-agent';
export const OPENCODE_PLAN_AGENT = 'melink-plan';
/** The read-only answer-only agent defined for Ask mode. */
export const OPENCODE_ASK_AGENT = 'melink-ask';

/** A random per-turn suffix; unpredictable and unique enough for one child. */
export function opencodeAgentNonce(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The validated per-turn suffix. A supplied nonce is trimmed and must be
 * filename-safe; an empty or malformed one is replaced by a fresh random value,
 * exactly once, so the config key and `built.agent` can never diverge.
 */
export function opencodeAgentSuffix(nonce?: string): string {
  const trimmed = nonce?.trim();
  return trimmed && /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : opencodeAgentNonce();
}

/** A per-turn opencode config, plus what was actually applied. */
export interface OpencodeConfigResult {
  /** The config object, ready to be serialized into `OPENCODE_CONFIG_CONTENT`. */
  config: Record<string, unknown>;
  /** `provider/model` reference passed to `--model`; the id is never rewritten. */
  modelRef: string;
  /** The agent passed to `--agent`, from the mode. */
  agent: string;
  /** The context window applied to the model's `limit.context`, when known. */
  contextApplied?: number;
  /** The native reasoning effort applied when the model supports reasoning. */
  reasoningApplied?: string;
  /**
   * True when the caller requested a reasoning level but the model reports no
   * reasoning control, so the key was omitted rather than sending a value
   * opencode would ignore or reject.
   */
  reasoningUnsupported: boolean;
}

export interface OpencodeConfigInput {
  /** `melink.ollama.baseUrl`, the same base the direct adapter uses. */
  baseUrl: string;
  /** Every model id the live `GET /api/tags` returned. Never a hardcoded list. */
  modelIds: readonly string[];
  /** The model this turn is pinned to. Must be one of `modelIds`. */
  modelId: string;
  /** Resolved per-model settings from the capability registry, already clamped. */
  settings?: ModelSettingOverrides;
  /** The selected model's capability descriptor, for the reasoning control. */
  capabilities?: ModelCapabilities;
  mode: DefaultMode;
  permissionLevel: PermissionLevel;
  /**
   * Present when browser control is on. The command is added as one MCP server
   * and does not replace servers the user's own config already has: OpenCode
   * merges this object over that config.
   */
  browser?: BrowserCommand;
  /**
   * Extra MCP servers (zvec-grep, ast-grep) merged beside the browser server.
   * Absolute command paths keep bundled installs working without PATH.
   */
  skillMcp?: Record<string, unknown>;
  /** Permission allows for enabled skill MCP servers/tools. */
  skillPermissions?: Record<string, 'allow'>;
  /** Test seam only; production generates a fresh random nonce per turn. */
  agentNonce?: string;
  /** Provider id in the generated config. Defaults to the Cloud provider. */
  providerId?: string;
  /** Provider display name in the generated config. */
  providerName?: string;
  /** Environment variable the generated provider reads its key from. */
  apiKeyEnv?: string;
}

/**
 * The OpenAI-compatible base URL for a configured Ollama base URL.
 *
 * The direct adapter talks to the native `/api`; opencode's OpenAI-compatible
 * adapter talks to `/v1`. A base that already names `/v1` is left alone, a
 * native `/api` suffix is swapped for `/v1`, and anything else gets `/v1`
 * appended, so the same setting points both paths at the same host.
 */
export function opencodeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return trimmed;
  }
  if (trimmed.endsWith('/api')) {
    return `${trimmed.slice(0, -'/api'.length)}/v1`;
  }
  return `${trimmed}/v1`;
}

/**
 * Max output tokens sent with a context limit.
 *
 * opencode's model schema requires `limit.output` whenever `limit` is present.
 * The budget is half the context window already selected for this model, at
 * least 1. A turn recomputes it from that setting, so a 1024k window can spend
 * a long investigation and a smaller window cannot be given an output budget
 * larger than itself. Nothing is written back onto the setting.
 */
export function outputLimitFor(context: number): number {
  if (!Number.isFinite(context) || context <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(context / 2));
}

/** The UI thinking level as an opencode/OpenAI-compatible reasoning effort. */
export function opencodeReasoningEffort(level: ThinkingLevel): string | undefined {
  switch (level) {
    case 'off':
      // `off` is the absence of an effort: nothing is sent, so the model default
      // holds rather than being told to reason less than it can.
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'extra high':
      // The generic OpenAI-compatible adapter accepts low/medium/high; the top
      // UI level aliases onto its highest tier rather than inventing a value.
      return 'high';
    default:
      return undefined;
  }
}

/** The opencode agent a mode maps onto, with a fresh unpredictable suffix. */
export function opencodeAgentForMode(mode: DefaultMode, nonce?: string): string {
  const base =
    mode === 'plan' ? OPENCODE_PLAN_AGENT : mode === 'ask' ? OPENCODE_ASK_AGENT : OPENCODE_AGENT_AGENT;
  return `${base}-${opencodeAgentSuffix(nonce)}`;
}

/** The fixed, prompt-overriding instruction each generated agent carries. */
function agentPrompt(mode: DefaultMode): string {
  switch (mode) {
    case 'ask':
      return 'Answer questions only. Do not change the workspace, run commands, or fetch the web.';
    case 'plan':
      return 'Investigate and write a plan. Do not implement it. Never bypass the permission rules or delegate to another agent.';
    default:
      return 'Act on the workspace using only the actions the permission rules allow. Never bypass them or delegate to another agent.';
  }
}

/**
 * The opencode `permission` block for a level after mode enforcement.
 *
 * Ask forces read-only and denies edit/write/patch/bash, external directories,
 * webfetch, websearch, and subagent delegation outright, whatever level was
 * selected: the mode narrows and can never widen. This is a second gate, not a
 * replacement for the mode's own agent restriction.
 *
 * `default` asks before every edit, write, patch, shell command, webfetch, and
 * websearch, and before leaving the project directory. Unlike Codex, opencode
 * has no OS sandbox it can apply to a process, so silently allowing bash or web
 * access would open the network; the prompt is the only gate. Only
 * `unrestricted` auto-allows these tools and `external_directory`.
 *
 * `task` (subagent delegation) is denied at every level except `unrestricted`:
 * a workspace `opencode.json` can define a subagent with its own permissive
 * rules, and older opencode releases do not inherit the parent turn's rules, so
 * leaving delegation open would bypass the selected level entirely.
 *
 * The generated permission block is the mechanism, not `--auto` (which the
 * bundled 1.19.x CLI does expose, but which would widen rather than narrow a
 * turn). `ask` is a real prompt: the runtime drives `opencode serve` and waits
 * for the user's decision when the backend has an approval channel.
 */
export function opencodePermission(
  level: PermissionLevel,
  mode: DefaultMode
): Record<string, 'allow' | 'ask' | 'deny'> {
  if (modeForcesReadOnly(mode)) {
    return { ...READ_ONLY_PERMISSION };
  }
  switch (level) {
    case 'read-only':
      return { ...READ_ONLY_PERMISSION };
    case 'unrestricted':
      return { ...UNRESTRICTED_PERMISSION };
    case 'default':
    default:
      // Edits stay ordinary workspace work, but a shell command always asks so
      // the host's destructive-command classifier and the approval card get a
      // chance to see it. Leaving the project directory and the network tools
      // ask too, and subagent delegation stays denied. Only `unrestricted`
      // allows bash, network access and delegation without an approval path.
      return { ...DEFAULT_PERMISSION, edit: 'allow', write: 'allow', patch: 'allow' };
  }
}

const READ_ONLY_PERMISSION: Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = {
  edit: 'deny',
  write: 'deny',
  patch: 'deny',
  bash: 'deny',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  task: 'deny'
};

const DEFAULT_PERMISSION: Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = {
  edit: 'ask',
  write: 'ask',
  patch: 'ask',
  bash: 'ask',
  external_directory: 'ask',
  webfetch: 'ask',
  websearch: 'ask',
  // A workspace can define its own subagent with permissive rules. Delegation
  // is denied outright so Read-only, Default, and Ask cannot be bypassed that
  // way; unrestricted is the only level that may spawn a subagent.
  task: 'deny'
};

const UNRESTRICTED_PERMISSION: Readonly<Record<string, 'allow' | 'ask' | 'deny'>> = {
  edit: 'allow',
  write: 'allow',
  patch: 'allow',
  bash: 'allow',
  external_directory: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  task: 'allow'
};

/** True when this level still has an `ask` the user must answer before a tool runs. */
export function opencodeRequiresApproval(level: PermissionLevel, mode: DefaultMode): boolean {
  return Object.values(opencodePermission(level, mode)).includes('ask');
}

/**
 * The custom agent definition for a mode.
 *
 * Each turn uses an unpredictable name and sets `disable: false` and an
 * explicit `prompt`, so a workspace cannot disable the agent, fall back to its
 * `build` agent, or replace the prompt. `tools.task` stays off so a workspace
 * cannot route the turn through a permissive subagent. Ask additionally
 * disables every mutating tool.
 */
export function opencodeAgentConfig(
  mode: DefaultMode,
  permission: Record<string, 'allow' | 'ask' | 'deny'>,
  nonce?: string
): Record<string, unknown> {
  const name = opencodeAgentForMode(mode, nonce);
  switch (mode) {
    case 'ask':
      return {
        [name]: {
          disable: false,
          description: 'Answers questions without changing the workspace.',
          mode: 'primary',
          prompt: agentPrompt(mode),
          tools: { write: false, edit: false, patch: false, bash: false, task: false },
          permission
        }
      };
    case 'plan':
      return {
        [name]: {
          disable: false,
          description: 'Investigates and writes a plan at the selected permission level.',
          mode: 'primary',
          prompt: agentPrompt(mode),
          tools: { task: false },
          permission
        }
      };
    default:
      return {
        [name]: {
          disable: false,
          description: 'Acts on the workspace at the selected permission level.',
          mode: 'primary',
          prompt: agentPrompt(mode),
          tools: { task: false },
          permission
        }
      };
  }
}

/**
 * Build the per-turn opencode config. The model list is exactly the ids the
 * caller read from `/api/tags`; only the selected model carries a capability
 * descriptor, so no other model's limit or reasoning is fabricated.
 */
export function buildOpencodeConfig(input: OpencodeConfigInput): OpencodeConfigResult {
  const { baseUrl, modelIds, modelId, settings, capabilities, mode, permissionLevel, browser } = input;
  const providerId = input.providerId ?? OPENCODE_PROVIDER_ID;
  const providerName = input.providerName ?? 'Ollama Cloud';
  const apiKeyEnv = input.apiKeyEnv ?? OPENCODE_API_KEY_ENV;
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
  // Only apply a reasoning effort when the model is known to reason. `off` is
  // the absence of effort and is intentionally omitted.
  const reasoningApplied =
    reasoningSupported && requestedThinking !== undefined
      ? opencodeReasoningEffort(requestedThinking)
      : undefined;
  const reasoningUnsupported =
    reasoningKnown && !reasoningSupported && requestedThinking !== undefined && requestedThinking !== 'off';

  const selected: Record<string, unknown> = { name: modelId, tool_call: true };
  if (contextApplied !== undefined) {
    // opencode 1.18 rejects a limit that names context without output
    // (`ConfigInvalidError` / Missing key). Output stays inside the window.
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
      [providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: providerName,
        // The provider reads this variable from its environment; only the name
        // is named here, so the token itself never appears in the config.
        env: [apiKeyEnv],
        options: {
          baseURL: opencodeBaseUrl(baseUrl)
        },
        models
      }
    },
    // Keep even the lightweight internal calls on the same model, so `opencode
    // run` never reaches for a different provider the user did not choose.
    small_model: `${providerId}/${modelId}`,
    // The sidebar has its own transcript; run opencode without sharing or
    // self-updating as a side effect of a turn.
    share: 'disabled',
    autoupdate: false,
    // The config is merged over the user's global/project config. Permissions
    // are set explicitly so the turn's level is honoured here too.
    permission: {
      ...opencodePermission(permissionLevel, resolvedMode),
      ...(browser ? browserPermissionKeys() : {}),
      ...(input.skillPermissions ?? {})
    }
  };
  const mcp = mergeOpencodeMcp(input.skillMcp, browser);
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
    modelRef: `${providerId}/${modelId}`,
    agent: opencodeAgentForMode(resolvedMode, nonce),
    contextApplied,
    reasoningApplied,
    reasoningUnsupported
  };
}

