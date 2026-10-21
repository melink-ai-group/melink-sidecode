/**
 * Package one platform-specific VSIX with the installed vsce. This is the
 * release entry point; plain `npm run package` keeps its host-default behavior.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeHost, RELEASE_TARGETS } from './dictation-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function valueFor(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const target = valueFor('--target') ?? valueFor('-t');
if (!target) {
  console.error(`Usage: node scripts/package-platform.mjs --target <${RELEASE_TARGETS.join('|')}>`);
  process.exit(2);
}
if (!RELEASE_TARGETS.includes(target)) {
  console.error(
    `Unknown release target "${target}". Supported targets: ${RELEASE_TARGETS.join(', ')}.`
  );
  process.exit(2);
}

const host = describeHost();
if (target !== host) {
  console.error(
    `Refusing to package ${target} on ${host}: dictation binaries are staged for the build host only. ` +
      `Run the ${target} build on a ${target} runner.`
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = `melink-sidecode-${version}-${target}.vsix`;
const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
if (!existsSync(vsce)) {
  console.error('vsce is not installed. Run npm ci before packaging.');
  process.exit(1);
}

console.log(`[package-platform] ${target} -> ${output}`);
const result = spawnSync(process.execPath, [vsce, 'package', '--target', target, '-o', output], {
  cwd: root,
  stdio: 'inherit'
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
