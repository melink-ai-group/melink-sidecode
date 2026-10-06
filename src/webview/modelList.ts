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

export function sortModels<T extends { id: string; label: string }>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => {
    const byLabel = left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' });
    if (byLabel !== 0) {
      return byLabel;
    }
    return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' });
  });
}
