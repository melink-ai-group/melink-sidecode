/**
 * Ordering helpers for the model picker.
 *
 * The provider tab opens on the model already in use. Each provider's rows
 * use one comparison (label, then id), so a refresh that returns the same
 * models in a different payload order does not reshuffle the list.
 */

export function defaultProviderTab(providerIds: readonly string[], selectedBackendId?: string): string {
  if (selectedBackendId && providerIds.includes(selectedBackendId)) {
    return selectedBackendId;
  }
  return providerIds[0] ?? '';
}

export function sortModels<T extends { id: string; label: string; free?: boolean }>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => {
    // Free models first when the provider marks pricing (OpenCode Zen).
    const leftFree = left.free === true ? 0 : 1;
    const rightFree = right.free === true ? 0 : 1;
    if (leftFree !== rightFree) {
      return leftFree - rightFree;
    }
    const byLabel = left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' });
    if (byLabel !== 0) {
      return byLabel;
    }
    return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' });
  });
}
