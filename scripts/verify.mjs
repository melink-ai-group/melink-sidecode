import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function walk(directory) {
  const entries = readdirSync(join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...walk(relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

function claim(document, label, pattern) {
  const match = document.match(pattern);
  if (!match) {
    fail(`docs/manual-test.md is missing the "${label}" claim (${pattern})`);
    return undefined;
  }
  return match[1];
}

const packageJson = JSON.parse(read('package.json'));
const version = packageJson.version;
const document = read('docs/manual-test.md');
const css = read('src/webview/styles.css');

const titleVersion = claim(
  document,
  'title version',
  /^#\s+Manual test script\s+[—–-]\s+sideCode v(\d+\.\d+\.\d+)/m,
);
const bulletVersion = claim(
  document,
  'package version',
  /\*\*Package version:\*\*\s*(\d+\.\d+\.\d+)/,
);
const claimedFiles = claim(
  document,
  'node test files',
  /\*\*Node test files:\*\*\s*(\d+)/,
);
const claimedTests = claim(
  document,
  'node tests',
  /\*\*Node tests:\*\*\s*(\d+)/,
);
const claimedHex = claim(
  document,
  'hex colour literals',
  /\*\*Hex colour literals:\*\*\s*(\d+)/,
);
const claimedHexLines = claim(
  document,
  'hex literal line count',
  /\*\*Hex colour literals:\*\*\s*\d+\s+occurrences?\s+across\s+(\d+)\s+lines?/,
);
const documentedTypecheckErrors = claim(
  document,
  'typecheck baseline',
  /\*\*Typecheck:\*\*\s*(\d+)\s+known/,
);

const testFiles = walk('src').filter((file) => file.endsWith('.test.ts'));
let declaredTests = 0;
for (const file of testFiles) {
  const source = read(file);
  declaredTests += (source.match(/^\s*(?:test|it)\s*\(/gm) ?? []).length;
}

const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
const hexLines = css
  .split(/\r?\n/)
  .filter((line) => /#[0-9a-fA-F]{3,8}\b/.test(line)).length;

if (titleVersion !== version) {
  fail(`title says sideCode v${titleVersion}, package.json says v${version}`);
}
if (bulletVersion !== version) {
  fail(`baseline says package version ${bulletVersion}, package.json says ${version}`);
}
if (claimedFiles !== String(testFiles.length)) {
  fail(
    `docs/manual-test.md claims ${claimedFiles} node test files, the tree has ${testFiles.length}`,
  );
}
if (claimedTests !== String(declaredTests)) {
  fail(
    `docs/manual-test.md claims ${claimedTests} node tests, the tree declares ${declaredTests}`,
  );
}
if (claimedHex !== String(hexMatches.length)) {
  fail(
    `docs/manual-test.md claims ${claimedHex} hex colour literals, styles.css has ${hexMatches.length}`,
  );
}
if (claimedHexLines !== String(hexLines)) {
  fail(
    `docs/manual-test.md claims ${claimedHexLines} lines containing hex colour literals, styles.css has ${hexLines}`,
  );
}

const artifactRelativePath = '.melink-verify.json';
let artifactStatus = 'absent (deleted/untracked artifact)';
if (existsSync(join(root, artifactRelativePath))) {
  try {
    const artifact = JSON.parse(read(artifactRelativePath));
    artifactStatus = 'present, checked against the tree';
    const comparisons = [
      ['version', version],
      ['tests', declaredTests],
      ['files', testFiles.length],
      ['hexLiterals', hexMatches.length],
    ];
    for (const [key, measured] of comparisons) {
      if (artifact[key] !== measured) {
        fail(
          `.melink-verify.json ${key} is ${JSON.stringify(artifact[key])}, the tree measures ${measured}`,
        );
      }
    }
    if (
      documentedTypecheckErrors !== undefined &&
      artifact.typecheckErrors !== Number(documentedTypecheckErrors)
    ) {
      fail(
        `.melink-verify.json typecheckErrors is ${JSON.stringify(artifact.typecheckErrors)}, the document records ${documentedTypecheckErrors}`,
      );
    }
  } catch (error) {
    fail(`${artifactRelativePath} exists but cannot be read as JSON: ${error.message}`);
  }
}

console.log('sideCode verify — docs/manual-test.md vs the working tree');
console.log(`  package version:      ${version}`);
console.log(`  node test files:      ${testFiles.length}`);
console.log(`  node tests:           ${declaredTests}`);
console.log(`  hex colour literals:  ${hexMatches.length} (${hexLines} lines)`);
console.log(
  `  typecheck baseline:   ${
    documentedTypecheckErrors === undefined
      ? 'not documented'
      : `${documentedTypecheckErrors} known errors (documented, not run here)`
  }`,
);
console.log(`  .melink-verify.json:  ${artifactStatus}`);

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  console.error('');
  console.error('Fix docs/manual-test.md (or the tree) so the claims match, then rerun.');
  process.exit(1);
}

console.log('');
console.log('OK: documentation matches the current tree.');
console.log(
  'Verify only checks the claims above; it does not run typecheck or the test suites.',
);
