import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const nodeSuite = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', 'src/**/*.test.ts'],
  { cwd: root, stdio: 'inherit' }
);

const domSuite = spawnSync(process.execPath, [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], {
  cwd: root,
  stdio: 'inherit'
});

process.exitCode = nodeSuite.status === 0 && domSuite.status === 0 ? 0 : 1;
