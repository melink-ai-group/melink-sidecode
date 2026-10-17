/**
 * OpenCode Zen model catalog: live ids from Zen, free-ness from models.dev cost.
 *
 * Pure helpers stay free of `vscode` and of the CLI. Fetch wrappers are thin.
 */

import type { BackendModel, ModelCapabilities, ThinkingLevel } from '../types.ts';
import { UNKNOWN_CAPABILITIES, normalizeContextWindow } from '../capabilities.ts';

export const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** Known zero-cost stealth ids when models.dev is unreachable (ids ending in `-free` also count). */
export const KNOWN_FREE_MODEL_IDS: readonly string[] = ['big-pickle'];

export interface ZenModelRaw {
  id: string;
}

export interface ModelsDevCost {
  input?: number;
  output?: number;
}

export interface ModelsDevModelMeta {
  name?: string;
  cost?: ModelsDevCost;
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  tool_call?: boolean;
}

export interface ZenCatalogOptions {
  /** When false, paid models are omitted. */
  includePaid: boolean;
}

/**
 * Whether a models.dev cost row is free. Both input and output must be zero;
 * missing cost is not treated as free (unknown → not free unless name fallback).
 */
export function isFreeCost(cost: ModelsDevCost | undefined): boolean {
  if (!cost) {
    return false;
  }
  const input = cost.input;
  const output = cost.output;
  return input === 0 && output === 0;
}

/** Fallback free detection when models.dev has no row for the id. */
export function isFreeByIdFallback(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed === 'test') {
    return false;
  }
  if (trimmed.endsWith('-free')) {
    return true;
  }
  return KNOWN_FREE_MODEL_IDS.includes(trimmed);
}

/** Drop junk and non-coding System One models from the coding picker. */
export function shouldOmitZenModelId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed === 'test') {
    return true;
  }
  return trimmed.startsWith('jev-');
}

export function humanizeModelId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d/.test(part)) {
        return part;
      }
      if (part.length <= 3 && part === part.toLowerCase()) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

/**
 * Merge Zen live ids with models.dev metadata into picker rows.
 * Free models always carry `free: true`. Paid rows are omitted when `includePaid` is false.
 */
export function mergeZenCatalog(
  zenIds: readonly string[],
  metaById: Readonly<Record<string, ModelsDevModelMeta>>,
  options: ZenCatalogOptions
): BackendModel[] {
  const models: BackendModel[] = [];
  for (const rawId of zenIds) {
    const id = rawId.trim();
    if (shouldOmitZenModelId(id)) {
      continue;
    }
    const meta = metaById[id];
    const free = meta ? isFreeCost(meta.cost) : isFreeByIdFallback(id);
    if (!free && !options.includePaid) {
      continue;
    }
    const label = meta?.name?.trim() || humanizeModelId(id);
    const capabilities = capabilitiesFromMeta(meta);
    models.push({
      id,
      label,
      ...(free ? { free: true } : {}),
      ...(capabilities ? { capabilities } : {})
    });
  }
  return models;
}

export function capabilitiesFromMeta(meta: ModelsDevModelMeta | undefined): ModelCapabilities | undefined {
  if (!meta) {
    return {
      ...UNKNOWN_CAPABILITIES,
      tools: true
    };
  }
  const contextWindow = normalizeContextWindow({
    max: meta.limit?.context,
    default: meta.limit?.context
  });
  const thinkingSupported: ThinkingLevel[] | 'unknown' =
    meta.reasoning === true
      ? (['low', 'medium', 'high', 'extra high'] as ThinkingLevel[])
      : meta.reasoning === false
        ? []
        : 'unknown';
  return {
    contextWindow,
    thinking: {
      supported: thinkingSupported,
      default: thinkingSupported === 'unknown' ? 'unknown' : thinkingSupported[0] ?? 'unknown'
    },
    tools: meta.tool_call === false ? false : true,
    modes: 'unknown'
  };
}

/** Parse Zen `/v1/models` JSON into ids. */
export function parseZenModelsResponse(body: unknown): string[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim()) {
      ids.push(id.trim());
    }
  }
  return ids;
}

/** Extract the `opencode` provider model map from models.dev `api.json`. */
export function parseModelsDevOpencode(body: unknown): Record<string, ModelsDevModelMeta> {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const root = body as Record<string, unknown>;
  const provider =
    (root.opencode as Record<string, unknown> | undefined) ??
    ((root.providers as Record<string, unknown> | undefined)?.opencode as Record<string, unknown> | undefined);
  if (!provider || typeof provider !== 'object') {
    return {};
  }
  const models = provider.models;
  if (!models || typeof models !== 'object') {
    return {};
  }
  const out: Record<string, ModelsDevModelMeta> = {};
  for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const row = value as Record<string, unknown>;
    const cost = row.cost && typeof row.cost === 'object' ? (row.cost as ModelsDevCost) : undefined;
    const limit = row.limit && typeof row.limit === 'object' ? (row.limit as { context?: number; output?: number }) : undefined;
    out[id] = {
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
      ...(cost ? { cost } : {}),
      ...(limit ? { limit } : {}),
      ...(typeof row.reasoning === 'boolean' ? { reasoning: row.reasoning } : {}),
      ...(typeof row.tool_call === 'boolean' ? { tool_call: row.tool_call } : {})
    };
  }
  return out;
}

/** Fetch and merge the live Zen catalog. Never throws; empty on total failure. */
export async function fetchZenCatalog(options: ZenCatalogOptions, fetchImpl: typeof fetch = fetch): Promise<BackendModel[]> {
  const [zenBody, modelsDevBody] = await Promise.all([
    fetchJson(ZEN_MODELS_URL, fetchImpl),
    fetchJson(MODELS_DEV_URL, fetchImpl)
  ]);
  const ids = parseZenModelsResponse(zenBody);
  if (ids.length === 0) {
    return [];
  }
  const meta = parseModelsDevOpencode(modelsDevBody);
  return mergeZenCatalog(ids, meta, options);
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      return undefined;
    }
    return await response.json();
  } catch {
    return undefined;
  }
}
