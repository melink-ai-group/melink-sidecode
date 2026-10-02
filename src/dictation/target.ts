export interface DictationTarget {
  backendId: 'ollama' | 'codex';
  modelId: string;
}

/** Read the settings value. A bare model id is an Ollama model from the earlier picker. */
export function parseDictationTarget(value: string | undefined): DictationTarget | undefined {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return undefined;
  }
  const split = trimmed.indexOf('|');
  if (split === -1) {
    return { backendId: 'ollama', modelId: trimmed };
  }
  const backendId = trimmed.slice(0, split);
  const modelId = trimmed.slice(split + 1).trim();
  if ((backendId !== 'ollama' && backendId !== 'codex') || !modelId) {
    return undefined;
  }
  return { backendId, modelId };
}

/** The value stored and shown in the settings picker. */
export function formatDictationTarget(value: string | undefined): string {
  const parsed = parseDictationTarget(value);
  return parsed ? `${parsed.backendId}|${parsed.modelId}` : '';
}
