import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The review pass is opt-in. This reads the real manifest so a default flip or a
 * resource-scoped setting cannot slip through review unnoticed.
 */

async function properties(): Promise<
  Record<string, { type?: string; default?: unknown; scope?: string }>
> {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: { properties: Record<string, { type?: string; default?: unknown; scope?: string }> };
    };
  };
  return manifest.contributes.configuration.properties;
}

test('melink.review.diffReview stays an application-scoped opt-in, default off', async () => {
  const setting = (await properties())['melink.review.diffReview'];

  assert.ok(setting, 'the setting is contributed');
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
  assert.equal(setting.scope, 'application');
});

test('melink.orchestration.reviewing is a window-scoped Auto/On/Off choice', async () => {
  const setting = (await properties())['melink.orchestration.reviewing'] as {
    type?: string | string[];
    enum?: unknown[];
    default?: unknown;
    scope?: string;
  };

  assert.ok(setting, 'the setting is contributed');
  assert.deepEqual(setting.type, ['boolean', 'string']);
  // Legacy stored booleans must stay schema-valid; the reader migrates them.
  assert.deepEqual(setting.enum, ['auto', 'on', 'off', true, false]);
  assert.equal(setting.default, 'auto');
  assert.equal(setting.scope, undefined);
});
