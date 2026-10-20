/**
 * Node 22.6+/22.12-compatible ESM loader for adapter tests.
 *
 * - resolves the bare `vscode` specifier to a host-free stub fixture
 * - resolves the adapter's extensionless relative imports to `.ts`
 *
 * Registered with `module.register()` (available before `module.registerHooks`)
 * so the same test file imports and runs on Node 22.12 and newer.
 */
const vscodeStubUrl = new URL('./vscodeStub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: vscodeStubUrl, shortCircuit: true };
  }
  if (specifier.startsWith('.') && !/\.(ts|tsx|js|mjs|json)$/.test(specifier)) {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}
