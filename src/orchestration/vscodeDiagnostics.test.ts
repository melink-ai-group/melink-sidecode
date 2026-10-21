import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

register(pathToFileURL(resolve('src/backends/testSupport/vscodeLoader.mjs')).href);

async function loadBinding(): Promise<typeof import('./vscodeDiagnostics.ts')> {
  return import('./vscodeDiagnostics.ts');
}

test('the diagnostics binding reads only errors for the requested path', async () => {
  const { readFileDiagnostics } = await loadBinding();
  const seen: unknown[] = [];
  const errors = readFileDiagnostics('C:/repo/src/a.ts', {
    uri: (absPath) => ({ absPath }),
    read: (uri) => {
      seen.push(uri);
      return [{ severity: 0 }, { severity: 1 }, { severity: 2 }, { severity: 0 }];
    },
    errorSeverity: 0
  });

  assert.deepEqual(seen, [{ absPath: 'C:/repo/src/a.ts' }]);
  assert.deepEqual(errors, [{ severity: 'error' }, { severity: 'error' }]);
});

test('a file with no error diagnostics produces no entries', async () => {
  const { readFileDiagnostics } = await loadBinding();
  const diagnostics = readFileDiagnostics('C:/repo/src/a.ts', {
    uri: (absPath) => absPath,
    read: () => [{ severity: 1 }, { severity: 3 }],
    errorSeverity: 0
  });
  assert.deepEqual(diagnostics, []);
});
