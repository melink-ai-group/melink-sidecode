import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The review pass is opt-in. This reads the real manifest so a default flip or a
 * resource-scoped setting cannot slip through review unnoticed.
 */

test('melink.review.diffReview is an application-scoped opt-in, default off', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: {
        properties: Record<string, { type?: string; default?: unknown; scope?: string }>;
      };
    };
  };
  const setting = manifest.contributes.configuration.properties['melink.review.diffReview'];

  assert.ok(setting, 'the setting is contributed');
  assert.equal(setting.type, 'boolean');
  assert.equal(setting.default, false);
  assert.equal(setting.scope, 'application');
});
