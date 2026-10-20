import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectConventions,
  type ConventionFact,
  type ConventionManifest,
  type ConventionSummary
} from './conventions.ts';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Harness {
  files: Record<string, string>;
  manifests: ConventionManifest[];
  reads: string[];
  violations: string[];
  run: (overrides?: { maxSamples?: number; maxBytes?: number }) => Promise<ConventionSummary | undefined>;
}

function harness(files: Record<string, string>, manifests: ConventionManifest[] = []): Harness {
  const reads: string[] = [];
  const violations: string[] = [];
  const provided = new Set(Object.keys(files));
  const h: Harness = {
    files,
    manifests,
    reads,
    violations,
    async run(overrides = {}) {
      return detectConventions({
        files: Object.keys(files),
        manifests,
        maxSamples: overrides.maxSamples,
        maxBytes: overrides.maxBytes,
        async readFile(path: string) {
          reads.push(path);
          if (!provided.has(path)) {
            violations.push(path);
            return undefined;
          }
          return files[path];
        }
      });
    }
  };
  return h;
}

function fact(summary: ConventionSummary | undefined, label: string): ConventionFact | undefined {
  return summary?.facts.find((entry) => entry.label === label);
}

function tsRepo(): Harness {
  return harness({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 2\nquote_type = single\n',
    '.prettierrc': '{"singleQuote": true}',
    '.eslintrc.json': '{"root": true}',
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { test: 'node --experimental-strip-types --test "src/**/*.test.ts"' },
      devDependencies: { eslint: '9.0.0', prettier: '3.0.0' }
    }),
    'README.md': '# App\n\nBody text is never a sample.',
    'src/api-client.ts': [
      "import { helper } from './helper';",
      '',
      'export function apiClient(): number {',
      '  const value = helper();',
      '  return value;',
      '}'
    ].join('\n'),
    'src/user-store.ts': [
      "import { helper } from './helper';",
      '',
      'export const userStore = helper();',
      "export const label = 'store';"
    ].join('\n'),
    'src/render-view.ts': [
      'export function renderView(): string {',
      "  return 'view';",
      '}'
    ].join('\n'),
    'src/api-client.test.ts': "import test from 'node:test';\ntest('x', () => {});\n"
  });
}

/* -------------------------------------------------------------------------- */
/* Config-driven detection                                                    */
/* -------------------------------------------------------------------------- */

test('TypeScript config yields formatter, linter, node:test, files, naming and style facts', async () => {
  const summary = await tsRepo().run();
  assert.ok(summary);
  assert.equal(fact(summary, 'Formatter')?.value, 'Prettier');
  assert.equal(fact(summary, 'Formatter')?.source, '.prettierrc');
  assert.equal(fact(summary, 'Linter')?.value, 'ESLint');
  assert.equal(fact(summary, 'Linter')?.source, '.eslintrc.json');
  assert.equal(fact(summary, 'Test runner')?.value, 'node:test');
  assert.equal(fact(summary, 'Test files')?.value, 'colocated *.test.ts');
  assert.equal(fact(summary, 'Test files')?.source, 'src/api-client.test.ts');
  assert.equal(fact(summary, 'Indentation')?.value, '2 spaces');
  assert.equal(fact(summary, 'Indentation')?.source, '.editorconfig');
  assert.equal(fact(summary, 'Quotes')?.value, 'single quotes');
  assert.equal(fact(summary, 'Semicolons')?.value, 'yes');
  assert.equal(fact(summary, 'File naming')?.value, 'kebab-case');
  assert.ok(summary.text.startsWith('Conventions:'));
});

test('node:test is detected from the package.json test script value', async () => {
  const command = 'node --experimental-strip-types --test "src/**/*.test.ts" --runner-secret-token';
  const repo = harness({
    'package.json': JSON.stringify({
      scripts: { test: command }
    }),
    'src/format.ts': 'export const x = 1;\n',
    'src/format.test.ts': "import test from 'node:test';\n"
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Test runner')?.value, 'node:test');
  assert.equal(fact(summary, 'Test runner')?.source, 'package.json');
  assert.equal(summary?.text.includes('--runner-secret-token'), false, 'only the derived runner is rendered');
  assert.equal(summary?.text.includes(command), false);
});

test('vitest and jest are recognized from dependencies, with their test file naming', async () => {
  const vitest = harness({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '3.0.0' } }),
    'src/format.ts': 'export const x = 1;\n',
    'src/format.test.ts': "import { test } from 'vitest';\n"
  });
  const v = await vitest.run();
  assert.equal(fact(v, 'Test runner')?.value, 'vitest');
  assert.equal(fact(v, 'Test files')?.value, 'colocated *.test.ts');

  const jest = harness({
    'package.json': JSON.stringify({ devDependencies: { jest: '30.0.0' } }),
    'src/format.ts': 'export const x = 1;\n',
    'src/__tests__/format.ts': 'test("x", () => {});\n'
  });
  const j = await jest.run();
  assert.equal(fact(j, 'Test runner')?.value, 'jest');
  assert.equal(fact(j, 'Test files')?.value, 'tests directory __tests__/');
});

test('Python pyproject yields ruff, pytest and snake_case test naming', async () => {
  const repo = harness({
    'pyproject.toml': [
      '[tool.ruff]',
      'line-length = 100',
      '[tool.black]',
      'line-length = 100',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]'
    ].join('\n'),
    'src/data_loader.py': "VALUE = 'x'\n",
    'src/format_rows.py': "OTHER = 'y'\n",
    'src/text_utils.py': "THIRD = 'z'\n",
    'tests/test_data_loader.py': 'def test_load():\n    assert True\n'
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Formatter')?.value, 'ruff');
  assert.equal(fact(summary, 'Linter')?.value, 'ruff');
  assert.equal(fact(summary, 'Test runner')?.value, 'pytest');
  assert.equal(fact(summary, 'Test runner')?.source, 'pyproject.toml');
  assert.equal(fact(summary, 'Test files')?.value, 'tests directory test_*.py');
  assert.equal(fact(summary, 'File naming')?.value, 'snake_case');
});

test('black alone is reported without inventing a ruff linter', async () => {
  const repo = harness({
    'pyproject.toml': '[tool.black]\nline-length = 88\n',
    'src/a_module.py': "VALUE = 'x'\n"
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Formatter')?.value, 'black');
  assert.equal(fact(summary, 'Linter'), undefined);
});

test('Rust Cargo and rustfmt are recognized', async () => {
  const repo = harness({
    'Cargo.toml': '[package]\nname = "demo"\n',
    'rustfmt.toml': 'edition = "2021"\n',
    'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n',
    'src/main.rs': 'fn main() {}\n'
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Formatter')?.value, 'rustfmt');
  assert.equal(fact(summary, 'Test runner')?.value, 'cargo test');
  assert.equal(fact(summary, 'Test runner')?.source, 'Cargo.toml');
});

test('Go modules are recognized with their test file naming', async () => {
  const repo = harness({
    'go.mod': 'module example.com/demo\n\ngo 1.22\n',
    'pkg/foo.go': 'package pkg\n\nfunc Add(a int, b int) int { return a + b }\n',
    'pkg/foo_test.go': 'package pkg\n'
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Test runner')?.value, 'go test');
  assert.equal(fact(summary, 'Test files')?.value, 'colocated *_test.go');
});

test('manifest-only Cargo metadata is enough to name cargo test without a file read', async () => {
  const repo = harness({ 'README.md': '# Demo\n' }, [{ path: 'Cargo.toml', fields: { name: 'demo' } }]);
  const summary = await repo.run();
  assert.equal(fact(summary, 'Test runner')?.value, 'cargo test');
  assert.equal(fact(summary, 'Test runner')?.source, 'Cargo.toml');
});

test('Biome and dprint are recognized from config', async () => {
  const biome = harness({
    'biome.json': '{}',
    'src/a.ts': 'export const a = 1;\n'
  });
  const biomeSummary = await biome.run();
  assert.equal(fact(biomeSummary, 'Formatter')?.value, 'Biome');
  assert.equal(fact(biomeSummary, 'Linter')?.value, 'Biome');

  const dprint = harness({
    'dprint.json': '{}',
    'src/b.ts': 'export const b = 2;\n'
  });
  assert.equal(fact(await dprint.run(), 'Formatter')?.value, 'dprint');
});

test('the dot-prefixed dprint config is recognized too', async () => {
  const repo = harness({
    '.dprint.json': '{}',
    'src/c.ts': 'export const c = 3;\n'
  });
  assert.equal(fact(await repo.run(), 'Formatter')?.value, 'dprint');
});

test('mocha and ava are recognized from config and dependencies', async () => {
  const mocha = harness({
    '.mocharc.json': '{}',
    'test/format.test.js': 'describe("x", () => {});\n'
  });
  const mochaSummary = await mocha.run();
  assert.equal(fact(mochaSummary, 'Test runner')?.value, 'mocha');
  assert.equal(fact(mochaSummary, 'Test runner')?.source, '.mocharc.json');

  const ava = harness({
    'package.json': JSON.stringify({ devDependencies: { ava: '6.0.0' } }),
    'test/format.test.js': 'import test from "ava";\n'
  });
  assert.equal(fact(await ava.run(), 'Test runner')?.value, 'ava');
});

test('pytest names the config file that supplied the evidence', async () => {
  const setup = harness({
    'setup.cfg': '[tool:pytest]\ntestpaths = tests\n',
    'tests/test_a.py': 'def test_a():\n    assert True\n'
  });
  const setupSummary = await setup.run();
  assert.equal(fact(setupSummary, 'Test runner')?.value, 'pytest');
  assert.equal(fact(setupSummary, 'Test runner')?.source, 'setup.cfg');

  const tox = harness({
    'tox.ini': '[pytest]\naddopts = -q\n',
    'tests/test_b.py': 'def test_b():\n    assert True\n'
  });
  const toxSummary = await tox.run();
  assert.equal(fact(toxSummary, 'Test runner')?.value, 'pytest');
  assert.equal(fact(toxSummary, 'Test runner')?.source, 'tox.ini');
});

/* -------------------------------------------------------------------------- */
/* Style sampling                                                             */
/* -------------------------------------------------------------------------- */

test('tabs win only when a strong majority of sampled files use them', async () => {
  const tabs = harness({
    'src/a.ts': 'function a() {\n\treturn 1;\n}\n',
    'src/b.ts': 'function b() {\n\treturn 2;\n}\n',
    'src/c.ts': 'function c() {\n\treturn 3;\n}\n'
  });
  assert.equal(fact(await tabs.run(), 'Indentation')?.value, 'tabs');

  const split = harness({
    'src/a.ts': 'function a() {\n  const first = 1;\n  const other = 2;\n  return first + other;\n}\n',
    'src/b.ts': 'function b() {\n  const second = 2;\n  const other = 3;\n  return second + other;\n}\n',
    'src/c.ts': 'function c() {\n\tconst third = 3;\n\tconst other = 4;\n\treturn third + other;\n}\n'
  });
  const summary = await split.run();
  assert.ok(summary);
  assert.equal(fact(summary, 'Indentation'), undefined);
});

test('quote and semicolon facts require a strong majority and enough evidence', async () => {
  const doubleNoSemi = harness({
    'src/a.ts': 'const a = "one"\nconst b = "two"\nconst c = "three"\n',
    'src/b.ts': 'const d = "four"\nconst e = "five"\nconst f = "six"\n',
    'src/c.ts': 'const g = "seven"\nconst h = "eight"\nconst i = "nine"\n'
  });
  const summary = await doubleNoSemi.run();
  assert.equal(fact(summary, 'Quotes')?.value, 'double quotes');
  assert.equal(fact(summary, 'Semicolons')?.value, 'no');

  const tooLittle = harness({
    'src/a.ts': 'export const a = 1\n',
    'src/b.ts': 'export const b = 2\n'
  });
  const thin = await tooLittle.run();
  assert.equal(fact(thin, 'Quotes'), undefined);
  assert.equal(fact(thin, 'Semicolons'), undefined);
});

test('file and component naming report only a strong majority', async () => {
  const repo = harness({
    'src/fooBar.ts': 'export const a = 1;\n',
    'src/bazQux.ts': 'export const b = 1;\n',
    'src/alphaBeta.ts': 'export const c = 1;\n'
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'File naming')?.value, 'camelCase');

  const components = harness({
    'src/UserCard.tsx': 'export function UserCard() { return null; }\n',
    'src/AppShell.tsx': 'export function AppShell() { return null; }\n'
  });
  const componentSummary = await components.run();
  assert.equal(fact(componentSummary, 'Component naming')?.value, 'PascalCase');

  const split = harness({
    'src/user-card.ts': 'export const a = 1;\n',
    'src/user-profile.ts': 'export const b = 1;\n',
    'src/formatRows.ts': 'export const c = 1;\n',
    'src/parseRows.ts': 'export const d = 1;\n'
  });
  assert.equal(fact(await split.run(), 'File naming'), undefined);
});

test('EditorConfig style overrides disagreeing samples and is attributed', async () => {
  const repo = harness({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 4\nquote_type = double\n',
    'src/a.ts': "function a() {\n\treturn 'x';\n}\n",
    'src/b.ts': "function b() {\n\treturn 'y';\n}\n"
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Indentation')?.value, '4 spaces');
  assert.equal(fact(summary, 'Indentation')?.source, '.editorconfig');
  assert.equal(fact(summary, 'Quotes')?.value, 'double quotes');
});

/* -------------------------------------------------------------------------- */
/* Bounds, gating, determinism                                                */
/* -------------------------------------------------------------------------- */

test('an empty or unevidenced tree returns undefined', async () => {
  assert.equal(await harness({}).run(), undefined);
  assert.equal(await harness({ 'README.md': '# App\n\nNo code here.\n' }).run(), undefined);
  assert.equal(await harness({ 'package.json': '{"name":"app"}' }).run(), undefined);
});

test('detection is deterministic for the same tree', async () => {
  const first = await tsRepo().run();
  const second = await tsRepo().run();
  assert.deepEqual(first, second);
});

test('text is capped with an explicit truncation marker', async () => {
  const summary = await tsRepo().run({ maxBytes: 80 });
  assert.ok(summary);
  assert.equal(summary.truncated, true);
  assert.ok(summary.bytes <= 80);
  assert.match(summary.text, /\(truncated\)$/);
});

test('at most eight source files are sampled by default', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 12; index += 1) {
    files[`src/mod-${index}.ts`] = `export const value${index} = ${index};\n`;
  }
  const repo = harness(files);
  const summary = await repo.run();
  assert.ok(summary);
  assert.equal(summary.samplesRead, 8);
  assert.equal(repo.reads.filter((path) => path.endsWith('.ts')).length, 8);

  const clamped = harness(files);
  const clampedSummary = await clamped.run({ maxSamples: 20 });
  assert.equal(clampedSummary?.samplesRead, 8);
  assert.equal(clamped.reads.filter((path) => path.endsWith('.ts')).length, 8);
});

test('style sampling never sees bytes past the per-sample cap', async () => {
  // The tail uses tabs but starts beyond the default 800-byte window, so only
  // the 2-space sample may vote.
  const head = 'const value = 1;\n'.repeat(70);
  const repo = harness({
    'src/a.ts': `${head}\tconst tail = 2;\n`,
    'src/b.ts': '  const first = 1;\n  const second = 2;\n  return first + second;\n'
  });
  const summary = await repo.run();
  assert.equal(fact(summary, 'Indentation')?.value, '2 spaces');
});

test('dependency, secret, lockfile and nested dot paths are never opened', async () => {
  const repo = harness({
    '.env': 'SECRET=do-not-read',
    'node_modules/dep/index.js': 'module.exports = 1;\n',
    'package-lock.json': '{}',
    '.cache/.prettierrc': '{}',
    'src/app.ts': 'export const app = 1;\n'
  });
  await repo.run();
  assert.deepEqual(repo.violations, []);
  assert.deepEqual(repo.reads, ['src/app.ts']);
});

test('files outside the provided list are never read', async () => {
  const repo = harness({ 'src/app.ts': 'export const app = 1;\n' });
  await repo.run();
  assert.deepEqual(repo.violations, []);
  assert.deepEqual(repo.reads, ['src/app.ts']);
});

test('raw sample bodies never appear in the summary', async () => {
  const sentinel = 'SAMPLE_BODY_SENTINEL_DO_NOT_ECHO';
  const repo = harness({
    '.editorconfig': '[*]\nindent_style = space\nindent_size = 2\n',
    'src/a.ts': `// ${sentinel}\nexport const a = 1;\n`,
    'src/b.ts': `// ${sentinel}\nexport const b = 2;\n`
  });
  const summary = await repo.run();
  assert.ok(summary);
  assert.equal(summary.text.includes(sentinel), false);
  assert.equal(JSON.stringify(summary).includes(sentinel), false);
});
