/**
 * Which provider receives the next turn.
 *
 * A model pick is stored on the chat even when the open thread still belongs
 * to the previous provider. The model the user chose decides the provider.
 * A stale thread must not keep sending that model to the provider being left.
 */
export function backendForTurn(input: {
  requestedBackendId?: string;
  requestedModel?: string;
  composerBackendId?: string;
  composerModelId?: string;
  threadBackendId?: string;
  availableBackendId?: string;
}): string | undefined {
  const chosen =
    input.requestedModel &&
    input.composerBackendId &&
    input.composerModelId === input.requestedModel
      ? input.composerBackendId
      : undefined;
  return chosen ?? input.requestedBackendId ?? input.threadBackendId ?? input.availableBackendId;
}
