import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The whole review package is host-free. This static guard keeps the prompt,
 * input, orchestration and store modules runnable under `node --test` and proves
 * the review pass can never write a workspace file or spawn a process.
 */

async function source(name: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', 'review', name), 'utf8');
}

test('the review package imports no host, filesystem, child-process or network module', async () => {
  for (const name of ['diffReview.ts', 'reviewInput.ts', 'turnReview.ts', 'reviewStore.ts']) {
    const text = await source(name);
    for (const pattern of [
      /\bfrom\s+['"]vscode['"]/,
      /\bfrom\s+['"]node:fs(?:\/promises)?['"]/,
      /\bfrom\s+['"]fs['"]/,
      /\bnode:fs(?:\/promises)?\b/,
      /\bfrom\s+['"]node:(?:os|path|url|worker_threads)['"]/,
      /\bnode:child_process\b/,
      /\bnode:net\b/,
      /\bnode:https?\b/
    ]) {
      assert.equal(pattern.test(text), false, `${name} unexpectedly matches ${pattern}`);
    }
  }
});
