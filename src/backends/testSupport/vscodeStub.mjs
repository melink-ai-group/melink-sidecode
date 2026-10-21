/**
 * Minimal scode stand-in for importing host-bound adapters under node:test.
 * Only the surface touched at import/read time by OllamaBackend is needed.
 */
export const workspace = {
  getConfiguration: () => ({
    get: (_key, fallback) => fallback,
    // The trust-sensitive read sites inspect the setting to tell user scope from
    // workspace scope; an unset setting has neither.
    inspect: () => undefined
  })
};

export default { workspace };