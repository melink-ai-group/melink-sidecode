import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the project-context delivery layer. These read the source
 * rather than run it, so they hold for every code path and are cheap.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the renderer is host-free, deterministic and never writes', async () => {
  const text = await source('context/render.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
  assert.equal(/\bwriteFile\b/.test(text), false);
  assert.equal(/\bappendFile\b/.test(text), false);
  assert.equal(/\boutputChannel\b/i.test(text), false);
  assert.equal(/\btelemetry\b/i.test(text), false);
});

test('the delivery layer takes the snapshot reads seam and names no workspace root of its own', async () => {
  const text = await source('context/delivery.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
  // The workspace root is owned by the snapshot service, not re-derived here.
  assert.equal(/workspaceRoots\s*\(/.test(text), false);
  assert.match(text, /ProjectContextReads/);
});

test('the message builder is host-free and provider-neutral', async () => {
  const text = await source('backends/contextMessages.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
  // It imports the provider-neutral context type only, never a provider adapter
  // or SDK, so every backend can share it.
  assert.equal(/from\s+['"][^'"]*ollama['"]/.test(text), false);
  assert.equal(/from\s+['"][^'"]*codex['"]/.test(text), false);
  assert.match(text, /import type \{ ContextPayload \}/);
});

test('the ollama adapter reads the transcript for context but never writes it', async () => {
  const text = await source('backends/ollama.ts');
  // The adapter builds the request messages from the stored transcript and the
  // per-turn context; it never writes context back to the store.
  assert.match(text, /buildContextMessages\(history, text, context\)/);
  assert.equal(/\bsetTranscript\b/.test(text), false);
  assert.equal(/\bappendUserMessage\b/.test(text), false);
});

test('the codex adapter delivers context through native instructions, not a synthetic turn', async () => {
  const text = await source('backends/codex.ts');
  // The snapshot is the native developerInstructions field. Mode is not stored
  // there: Codex keeps that field for the life of the loaded thread, so a Plan
  // instruction written at start would still block Build.
  assert.match(text, /developerInstructions: options\?\.context\?\.snapshot \?\? null/);
  assert.equal(/developerInstructions: combineInstructions\(modeInstructions/.test(text), false);
  // No fabricated user turn carries the context.
  assert.equal(/context\?\.snapshot[\s\S]{0,80}type: 'text'/.test(text), false);
});

test('the opencode prompt priming is documented as a deliberate fallback', async () => {
  const text = await source('backends/ollama.ts');
  assert.match(text, /native system\/instructions field/i);
  assert.match(text, /deliberate fallback, not an oversight/i);
  assert.match(text, /opencodePrompt\(request, fresh, fresh \? summary : undefined\)/);
});

test('the snapshot service owns the workspace root; adapters prefer it over the host', async () => {
  const codex = await source('backends/codex.ts');
  const ollama = await source('backends/ollama.ts');
  // Both child-process paths take the root from the context payload first and
  // fall back to the adapter's own read only when no context was supplied.
  assert.match(codex, /options\?\.context\?\.workspaceRoot \?\? this\.cwd/);
  assert.match(ollama, /request\.context\?\.workspaceRoot \?\? this\.cwd/);
});

test('the direct ollama path is unchanged when the opencode setting is off', async () => {
  const text = await source('backends/ollama.ts');
  // The setting gates the branch, and the runtime/config modules are imported
  // only inside it, so the off path loads neither and spawns no child.
  assert.match(text, /if \(this\.opencodeEnabled\) \{/);
  assert.match(text, /await import\('\.\/opencode\/config\.ts'\)/);
  assert.match(text, /await import\('\.\/opencode\/runtime\.ts'\)/);
  // No static value import of the runtime means the off path cannot spawn it.
  assert.equal(/import\s+[^;]*runOpencodeTurn[^;]*from\s+['"]\.\/opencode\/runtime['"]/.test(text), false);
});

test('a saved or external melink.context change re-arms open-thread context delivery', async () => {
  const view = await source('sidebarView.ts');
  const extension = await source('extension.ts');
  // Saving a context patch drops the per-thread rendered prefix, so the change
  // applies to the next turn of an open conversation rather than only a new one.
  assert.match(view, /key\.startsWith\('context'\)/);
  assert.match(view, /contextDelivery\.invalidateAll\(\)/);
  // A configuration change made outside the screen reaches the same re-prime.
  assert.match(extension, /affectsConfiguration\('melink\.context'\)/);
  assert.match(extension, /invalidateContextDelivery\(\)/);
});

test('invalidating context delivery drops the cached prefix and re-arms priming', async () => {
  const delivery = await source('context/delivery.ts');
  assert.match(delivery, /invalidateAll\(\): void/);
  assert.match(delivery, /snapshotText = undefined/);
  assert.match(delivery, /needPrime = true/);
});

test('the context view read model is host-free and never recomputes in the webview', async () => {
  const model = await source('context/contextView.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(model), false);
  assert.equal(/\bconsole\./.test(model), false);
  // The webview renders the pushed view and never builds one itself.
  const strip = await source('webview/ContextStrip.tsx');
  assert.equal(/buildContextView/.test(strip), false);
  assert.equal(/applyContextExclusions/.test(strip), false);
  assert.match(strip, /applyViewExclusions/);
});

test('per-turn exclusions shape the sent snapshot and are cleared after a turn', async () => {
  const view = await source('sidebarView.ts');
  // The exclusions are applied before the turn is sent, then cleared, so they
  // never persist silently into a later turn.
  assert.match(view, /exclusionKeys\(\)\.length > 0/);
  assert.match(view, /this\.contextDelivery\.setExclusions\(\[\]\)/);
  const delivery = await source('context/delivery.ts');
  assert.match(delivery, /applyContextExclusions\(snapshot, this\.exclusions\)/);
  assert.match(delivery, /applyContextExclusions\(current, this\.exclusions\)/);
});

test('the strip follows editor and selection changes without touching the transcript', async () => {
  const extension = await source('extension.ts');
  assert.match(extension, /onDidChangeActiveTextEditor\(\(\) => provider\.refreshContextView\(\)\)/);
  assert.match(extension, /onDidChangeTextEditorSelection\(\(\) => provider\.refreshContextView\(\)\)/);
  const view = await source('sidebarView.ts');
  // The refresh coalesces a burst and never dispatches a transcript action.
  assert.match(view, /private contextViewTimer\?/);
  assert.equal(/refreshContextView\(\)[\s\S]{0,200}transcript/.test(view), false);
});

test('the composer shows context fill and does not open project-context references', async () => {
  const strip = await source('webview/ContextStrip.tsx');
  assert.match(strip, /context-meter/);
  assert.match(strip, /onCompact/);
  const app = await source('webview/App.tsx');
  assert.match(app, /<ContextMeter/);
  assert.equal(/context-panel/.test(strip), false);
  assert.equal(/context-branch/.test(strip), false);
  assert.equal(/context-more/.test(strip), false);
  assert.equal(/setOpen/.test(strip), false);
});
