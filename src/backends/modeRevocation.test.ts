import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the mode-switch revocation. The provider modules import
 * `vscode` or spawn a CLI, so this reads their source instead of loading them.
 * It holds every provider to the same seam: the shared mode text builder plus a
 * per-chat record of the mode that was last applied.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('every provider composes mode text through the shared revocation seam', async () => {
  for (const file of [
    'backends/ollama.ts',
    'backends/opencodeBackend.ts',
    'backends/codex/turnInput.ts'
  ]) {
    const text = await source(file);
    assert.match(text, /modeInstructionsForTurn\(/, `${file} must use the shared mode text builder`);
    assert.equal(
      /(?:^|[^A-Za-z])modeInstructions\(/.test(text),
      false,
      `${file} must not bypass the revocation seam with modeInstructions`
    );
  }
});

test('the OpenCode-backed providers remember the last applied mode per chat', async () => {
  for (const file of ['backends/ollama.ts', 'backends/opencodeBackend.ts']) {
    const text = await source(file);
    assert.match(text, /appliedModes = new Map<string, DefaultMode>\(\)/, `${file} must track the applied mode`);
    assert.match(text, /appliedModes\.get\(handle\.threadId\)/, `${file} must read the previous mode`);
    assert.match(text, /appliedModes\.set\(handle\.threadId, mode\)/, `${file} must record the applied mode`);
    assert.match(text, /previousMode/, `${file} must pass the previous mode into the prompt`);
    // A bare steer sends only the new text, so it must not be treated as a
    // mode application.
    assert.match(text, /if \(barePrompt\) \{\s*return visibleText;\s*\}/);
  }
});

test('Codex revokes the earlier mode from its baked or resumed plan mode', async () => {
  const text = await source('backends/codex/turnInput.ts');
  assert.match(text, /input\.bakedMode !== input\.mode/);
  assert.match(text, /input\.revokePlan/);
  assert.match(text, /modeInstructionsForTurn\(input\.mode, previousMode, input\.frontendStack\)/);
});
