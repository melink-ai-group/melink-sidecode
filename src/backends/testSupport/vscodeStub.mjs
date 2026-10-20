/**
 * Minimal `vscode` stand-in for importing host-bound adapters under node:test.
 * Only the surface touched at import/read time by OllamaBackend is needed.
 */
export const workspace = {
  getConfiguration: () => ({ get: (_key, fallback) => fallback })
};

export default { workspace };
