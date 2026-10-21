/**
 * Derive a compact, evidenced summary of the project's coding conventions.
 *
 * The detector is host-free: it receives the bounded file list from the project
 * shape, a `readFile` seam (bound to the host by the caller) and the manifest
 * metadata the shape already read. It never imports `vscode`, the filesystem,
 * the network or a child process.
 *
 * ## Bounds
 *
 * - **Only listed files are read.** Every read goes through a guard that
 *   refuses any path not present in `files`, so the snapshot's exclusions and
 *   caps are respected implicitly.
 * - **Config before samples.** A small, fixed set of config names is parsed
 *   (JSON/TOML/INI, no dependencies). At most `maxSamples` source files are
 *   read, and only the first `maxBytes` bytes of each are inspected.
 * - **Evidence only.** Style facts are reported only when a strong majority
 *   (at least 70%) of the voting files agree. A guessed default is never
 *   reported, and raw sample bodies are never included in the output.
 * - **Deterministic.** The fact order, sources and byte cap are fixed; there
 *   are no timestamps or random values.
 */

/** One evidenced convention, with the path it was derived from. */
export interface ConventionFact {
  label: string;
  value: string;
  source: string;
}

/** The bounded summary the snapshot carries and the renderer prints once. */
export interface ConventionSummary {
  /** Rendered block starting with `Conventions:`, capped at `maxBytes`. */
  text: string;
  facts: ConventionFact[];
  /** True when the rendered text was cut to fit its cap. */
  truncated: boolean;
  /** UTF-8 byte length of `text`. */
  bytes: number;
  /** Number of source files whose bytes were inspected for style facts. */
  samplesRead: number;
}

/**
 * The manifest metadata the shape already read. Only small fields are present;
 * the detector uses the path (and Cargo/go presence) as evidence, never a body.
 */
export interface ConventionManifest {
  path: string;
  kind?: string;
  fields?: Record<string, string>;
}

export interface DetectConventionsInput {
  /** Workspace-relative, POSIX-style paths from `ProjectShape.files`. */
  files: readonly string[];
  /** `ProjectShape.manifests` (or just their metadata) for manifest evidence. */
  manifests?: readonly ConventionManifest[];
  /** Reads one listed file; the caller maps relative paths onto the host. */
  readFile: (path: string) => Promise<string | undefined>;
  /** Largest number of source files sampled for style. Default 8. */
  maxSamples?: number;
  /** Largest number of bytes inspected per sample. Default 800. */
  maxBytes?: number;
}

export const DEFAULT_CONVENTION_SAMPLES = 8;
export const DEFAULT_CONVENTION_BYTES = 800;

/** The fixed fact order, so two runs on the same tree render identically. */
const FACT_ORDER = [
  'Formatter',
  'Linter',
  'Test runner',
  'Test files',
  'Indentation',
  'Quotes',
  'Semicolons',
  'File naming',
  'Component naming'
] as const;

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go',
  '.vue', '.svelte',
  '.java', '.kt', '.cs',
  '.c', '.h', '.cc', '.cpp', '.hpp',
  '.rb', '.php', '.swift'
]);

const JS_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** A minimum majority; weaker splits are reported as no evidence. */
const STRONG_MAJORITY = 0.7;

interface Evidence {
  value: string;
  source: string;
}

/**
 * Detect conventions from the bounded snapshot. Returns `undefined` when the
 * tree provides no evidence, so the renderer never prints an empty block.
 */
export async function detectConventions(input: DetectConventionsInput): Promise<ConventionSummary | undefined> {
  const files = [...new Set(input.files.map(normalizePath))].sort();
  const fileSet = new Set(files);
  const readCache = new Map<string, string | undefined>();

  /** Read a file, but only when the bounded walk listed a safe text file. */
  const read = async (path: string): Promise<string | undefined> => {
    const key = normalizePath(path);
    if (!fileSet.has(key) || isUnsafePath(key)) {
      return undefined;
    }
    if (readCache.has(key)) {
      return readCache.get(key);
    }
    let text: string | undefined;
    try {
      text = await input.readFile(key);
    } catch {
      text = undefined;
    }
    readCache.set(key, text);
    return text;
  };

  const manifests = input.manifests ?? [];
  const manifestFor = (name: string): ConventionManifest | undefined =>
    manifests.find((manifest) => basename(manifest.path) === name.toLowerCase());

  const packagePath = rootFile(files, (path) => path === 'package.json');
  const packageText = packagePath ? await read(packagePath) : undefined;
  const packageJson = packageText ? parseJsonLoose(packageText) : undefined;

  const prettierPath = rootFile(
    files,
    (path) => path === '.prettierrc' || path.startsWith('.prettierrc.') || path.startsWith('prettier.config.')
  );
  const eslintPath = rootFile(
    files,
    (path) => path === '.eslintrc' || path.startsWith('.eslintrc.') || path.startsWith('eslint.config.')
  );
  const biomePath = rootFile(files, (path) => path === 'biome.json' || path === 'biome.jsonc');
  const dprintPath = rootFile(
    files,
    (path) => path === 'dprint.json' || path === 'dprint.jsonc' || path === '.dprint.json' || path === '.dprint.jsonc'
  );
  const editorConfigPath = rootFile(files, (path) => path === '.editorconfig');
  const ruffPath = rootFile(files, (path) => path === 'ruff.toml' || path === '.ruff.toml');
  const pyprojectPath = rootFile(files, (path) => path === 'pyproject.toml');
  const pytestPath = rootFile(files, (path) => path === '.pytest.ini' || path === 'pytest.ini');
  const setupCfgPath = rootFile(files, (path) => path === 'setup.cfg');
  const toxPath = rootFile(files, (path) => path === 'tox.ini');
  const rustfmtPath = rootFile(files, (path) => path === 'rustfmt.toml' || path === '.rustfmt.toml');
  const cargoPath = rootFile(files, (path) => path === 'cargo.toml');
  const goModPath = rootFile(files, (path) => path === 'go.mod');

  const pyprojectText = pyprojectPath ? await read(pyprojectPath) : undefined;
  const setupCfgText = setupCfgPath ? await read(setupCfgPath) : undefined;
  const toxText = toxPath ? await read(toxPath) : undefined;
  const prettierText = prettierPath ? await read(prettierPath) : undefined;
  const prettierOptions = prettierText ? parseJsonLoose(prettierText) : undefined;

  const deps = packageDependencies(packageJson);
  const scripts = packageScripts(packageJson);
  const testScript = typeof scripts.test === 'string' ? scripts.test : '';
  const hasDependency = (name: string): boolean => deps.has(name);
  const hasScriptRunner = (name: string): boolean =>
    new RegExp(`(^|[\\s&|;])${name}([\\s&|;]|$)`, 'i').test(testScript);

  const facts: ConventionFact[] = [];
  const add = (label: ConventionFact['label'], value: string, source: string): void => {
    facts.push({ label, value, source });
  };

  /* ------------------------------ formatter ------------------------------- */

  let formatter: Evidence | undefined;
  if (prettierPath || hasDependency('prettier') || packageJson?.prettier !== undefined) {
    formatter = { value: 'Prettier', source: prettierPath ?? packagePath ?? 'package.json' };
  } else if (biomePath || hasDependency('@biomejs/biome') || hasDependency('biome')) {
    formatter = { value: 'Biome', source: biomePath ?? packagePath ?? 'package.json' };
  } else if (dprintPath || hasDependency('dprint')) {
    formatter = { value: 'dprint', source: dprintPath ?? packagePath ?? 'package.json' };
  } else if (ruffPath || (pyprojectText && hasTomlSection(pyprojectText, 'tool.ruff')) || pythonDependency(pyprojectText, 'ruff')) {
    formatter = { value: 'ruff', source: ruffPath ?? 'pyproject.toml' };
  } else if ((pyprojectText && hasTomlSection(pyprojectText, 'tool.black')) || pythonDependency(pyprojectText, 'black')) {
    formatter = { value: 'black', source: 'pyproject.toml' };
  } else if (rustfmtPath) {
    formatter = { value: 'rustfmt', source: rustfmtPath };
  }
  if (formatter) {
    add('Formatter', formatter.value, formatter.source);
  }

  /* -------------------------------- linter -------------------------------- */

  let linter: Evidence | undefined;
  if (eslintPath || hasDependency('eslint') || packageJson?.eslintConfig !== undefined) {
    linter = { value: 'ESLint', source: eslintPath ?? packagePath ?? 'package.json' };
  } else if (biomePath || hasDependency('@biomejs/biome') || hasDependency('biome')) {
    linter = { value: 'Biome', source: biomePath ?? packagePath ?? 'package.json' };
  } else if (ruffPath || (pyprojectText && hasTomlSection(pyprojectText, 'tool.ruff')) || pythonDependency(pyprojectText, 'ruff')) {
    linter = { value: 'ruff', source: ruffPath ?? 'pyproject.toml' };
  }
  if (linter) {
    add('Linter', linter.value, linter.source);
  }

  /* ------------------------------ test runner ----------------------------- */

  const pytestSource =
    pytestPath ??
    (pyprojectText && hasTomlSection(pyprojectText, 'tool.pytest.ini_options') ? 'pyproject.toml' : undefined) ??
    (setupCfgText && parseIni(setupCfgText).has('tool:pytest') ? setupCfgPath ?? 'setup.cfg' : undefined) ??
    (toxText && parseIni(toxText).has('pytest') ? toxPath ?? 'tox.ini' : undefined) ??
    (pythonDependency(pyprojectText, 'pytest') ? 'pyproject.toml' : undefined);

  let runner: Evidence | undefined;
  if (hasScriptRunner('node') && /--test\b/.test(testScript)) {
    runner = { value: 'node:test', source: packagePath ?? 'package.json' };
  } else if (hasDependency('vitest') || hasScriptRunner('vitest') || rootFile(files, (path) => path.startsWith('vitest.config.'))) {
    runner = { value: 'vitest', source: configOrPackage(files, 'vitest', packagePath) };
  } else if (
    hasDependency('jest') ||
    hasDependency('@jest/core') ||
    hasScriptRunner('jest') ||
    rootFile(files, (path) => path.startsWith('jest.config.'))
  ) {
    runner = { value: 'jest', source: configOrPackage(files, 'jest', packagePath) };
  } else if (hasDependency('mocha') || hasScriptRunner('mocha') || rootFile(files, (path) => path.startsWith('.mocharc'))) {
    runner = { value: 'mocha', source: configOrPackage(files, 'mocha', packagePath) };
  } else if (hasDependency('ava') || hasScriptRunner('ava') || rootFile(files, (path) => path.startsWith('ava.config.'))) {
    runner = { value: 'ava', source: configOrPackage(files, 'ava', packagePath) };
  } else if (pytestSource) {
    runner = { value: 'pytest', source: pytestSource };
  } else if (cargoPath || manifestFor('cargo.toml')) {
    runner = { value: 'cargo test', source: cargoPath ?? manifestFor('cargo.toml')?.path ?? 'Cargo.toml' };
  } else if (goModPath || manifestFor('go.mod')) {
    runner = { value: 'go test', source: goModPath ?? manifestFor('go.mod')?.path ?? 'go.mod' };
  }
  if (runner) {
    add('Test runner', runner.value, runner.source);
  }

  /* ------------------------------- test files ----------------------------- */

  const testPattern = detectTestPattern(files);
  if (testPattern) {
    add('Test files', testPattern.value, testPattern.source);
  }

  /* ------------------------------ style samples --------------------------- */

  const maxSamples = Math.min(
    DEFAULT_CONVENTION_SAMPLES,
    Math.max(0, Math.trunc(input.maxSamples ?? DEFAULT_CONVENTION_SAMPLES))
  );
  const maxBytes = Math.max(1, Math.trunc(input.maxBytes ?? DEFAULT_CONVENTION_BYTES));
  const samples = selectSamples(files, maxSamples);
  const indentVotes = new Map<string, string[]>();
  const quoteVotes = new Map<string, string[]>();
  const semicolonVotes = new Map<string, string[]>();
  let samplesRead = 0;

  for (const path of samples) {
    const text = await read(path);
    if (text === undefined) {
      continue;
    }
    samplesRead += 1;
    const body = cutTextToBytes(text, maxBytes);
    const extension = extname(path);

    const indent = indentVote(body);
    if (indent) {
      vote(indentVotes, indent, path);
    }
    const quotes = quoteVote(body);
    if (quotes) {
      vote(quoteVotes, quotes, path);
    }
    if (JS_LIKE_EXTENSIONS.has(extension)) {
      const semicolons = semicolonVote(body);
      if (semicolons) {
        vote(semicolonVotes, semicolons, path);
      }
    }
  }

  const editorConfig = editorConfigStyles(
    editorConfigPath ? await read(editorConfigPath) : undefined,
    editorConfigPath
  );
  const prettierStyle = prettierStyles(prettierOptions, prettierPath);

  const indent = editorConfig.indent ?? prettierStyle.indent ?? decide(indentVotes);
  if (indent) {
    add('Indentation', indent.value, indent.source);
  }
  const quotes = editorConfig.quotes ?? prettierStyle.quotes ?? decide(quoteVotes);
  if (quotes) {
    add('Quotes', `${quotes.value} quotes`, quotes.source);
  }
  const semicolons = prettierStyle.semicolons ?? decide(semicolonVotes);
  if (semicolons) {
    add('Semicolons', semicolons.value === 'yes' ? 'yes' : 'no', semicolons.source);
  }

  /* -------------------------------- naming -------------------------------- */

  const naming = detectFileNaming(files);
  if (naming) {
    add('File naming', naming.value, naming.source);
  }
  const components = detectComponentNaming(files);
  if (components) {
    add('Component naming', components.value, components.source);
  }

  if (facts.length === 0) {
    return undefined;
  }

  facts.sort((a, b) => FACT_ORDER.indexOf(a.label as (typeof FACT_ORDER)[number]) - FACT_ORDER.indexOf(b.label as (typeof FACT_ORDER)[number]));

  const body = renderFacts(facts);
  const rendered = capText(body, maxBytes);
  return {
    text: rendered.text,
    facts,
    truncated: rendered.truncated,
    bytes: byteLength(rendered.text),
    samplesRead
  };
}

/* -------------------------------------------------------------------------- */
/* File selection and small path helpers                                      */
/* -------------------------------------------------------------------------- */

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return (index === -1 ? normalized : normalized.slice(index + 1)).toLowerCase();
}

/** Case-preserving basename, for naming classification. */
function fileName(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

function isRootFile(path: string): boolean {
  return !normalizePath(path).includes('/');
}

/** Directory names whose contents are never sampled or read as config. */
const UNSAFE_DIRECTORIES = new Set([
  'node_modules', 'vendor', '.venv', 'venv', '__pycache__',
  '.git', 'dist', 'out', 'build', 'bin', 'obj', 'target',
  'coverage', '.next', '.cache'
]);

/** Secret-store and key-material names, refused even if a caller lists them. */
const UNSAFE_NAMES = new Set([
  '.env', '.envrc', '.npmrc', '.netrc', '.htpasswd', 'credentials', 'secrets.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);

const UNSAFE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.bin', '.o', '.a',
  '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav'
]);

const UNSAFE_LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock', 'gemfile.lock'
]);

/**
 * The snapshot normally filters these already; repeating the check here keeps a
 * direct detector call from opening a dependency, secret, key, binary or
 * lockfile path that slipped through.
 */
function isUnsafePath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => UNSAFE_DIRECTORIES.has(segment.toLowerCase()))) {
    return true;
  }
  const name = basename(normalized);
  if (
    UNSAFE_NAMES.has(name) ||
    name.startsWith('.env.') ||
    UNSAFE_LOCKFILES.has(name) ||
    UNSAFE_EXTENSIONS.has(extname(normalized))
  ) {
    return true;
  }
  return false;
}

function rootFile(files: readonly string[], matcher: (path: string) => boolean): string | undefined {
  return files.find((path) => isRootFile(path) && matcher(path.toLowerCase()));
}

function configOrPackage(files: readonly string[], name: string, packagePath: string | undefined): string {
  const config = rootFile(
    files,
    (path) => path.startsWith(`${name}.config.`) || path.startsWith(`.${name}rc`)
  );
  return config ?? packagePath ?? 'package.json';
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path));
}

function isTestPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    /(^|\/)(__tests__|tests?|spec)\//i.test(normalized) ||
    /\.(test|spec)\.[a-z0-9]+$/i.test(normalized) ||
    /(^|\/)test_[^/]*\.py$/i.test(normalized) ||
    /_test\.(py|go|rs)$/i.test(normalized)
  );
}

/** Non-test sources first, then tests, each path-sorted; bounded by `max`. */
function selectSamples(files: readonly string[], max: number): string[] {
  if (max === 0) {
    return [];
  }
  const sources = files.filter((path) => isSourceFile(path) && !isUnsafePath(path)).sort();
  const preferred = sources.filter((path) => !isTestPath(path));
  const tests = sources.filter((path) => isTestPath(path));
  return [...preferred, ...tests].slice(0, max);
}

/* -------------------------------------------------------------------------- */
/* Config parsing (no dependencies)                                           */
/* -------------------------------------------------------------------------- */

function parseJsonLoose(text: string): Record<string, unknown> | undefined {
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(stripped) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function packageDependencies(json: Record<string, unknown> | undefined): Set<string> {
  const deps = new Set<string>();
  if (!json) {
    return deps;
  }
  for (const key of ['dependencies', 'devDependencies']) {
    const value = json[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of Object.keys(value as Record<string, unknown>)) {
        deps.add(name.toLowerCase());
      }
    }
  }
  return deps;
}

function packageScripts(source: Record<string, unknown> | Record<string, string> | undefined): Record<string, unknown> {
  if (!source || typeof source !== 'object') {
    return {};
  }
  const scripts = (source as Record<string, unknown>).scripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>)
    : {};
}

function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = '';
  const ensure = (name: string): Map<string, string> => {
    const existing = sections.get(name);
    if (existing) {
      return existing;
    }
    const created = new Map<string, string>();
    sections.set(name, created);
    return created;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      current = section[1].trim().toLowerCase();
      ensure(current);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals === -1) {
      continue;
    }
    ensure(current).set(line.slice(0, equals).trim().toLowerCase(), line.slice(equals + 1).trim());
  }
  return sections;
}

function hasTomlSection(text: string, section: string): boolean {
  return tomlSection(text, section) !== undefined;
}

function tomlSection(text: string, section: string): string | undefined {
  let current = '';
  let found = false;
  const body: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(raw);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current === section) {
      found = true;
      body.push(raw);
    }
  }
  return found ? body.join('\n') : undefined;
}

/** True when a Python dependency line (not arbitrary prose) names `name`. */
function pythonDependency(text: string | undefined, name: string): boolean {
  if (!text) {
    return false;
  }
  const pattern = new RegExp(`(^|[\\s"'])\\s*${name}\\s*(?:[<>=!~\\[]|["'])`, 'im');
  return pattern.test(text);
}

/* -------------------------------------------------------------------------- */
/* Style sampling                                                             */
/* -------------------------------------------------------------------------- */

function vote(votes: Map<string, string[]>, value: string, path: string): void {
  const existing = votes.get(value);
  if (existing) {
    existing.push(path);
  } else {
    votes.set(value, [path]);
  }
}

/** The winning style only when it holds at least 70% of the voting files. */
function decide(votes: Map<string, string[]>): { value: string; source: string } | undefined {
  let total = 0;
  let winner: { value: string; paths: string[] } | undefined;
  for (const [value, paths] of votes) {
    total += paths.length;
    if (!winner || paths.length > winner.paths.length) {
      winner = { value, paths };
    }
  }
  if (!winner || total === 0 || winner.paths.length / total < STRONG_MAJORITY) {
    return undefined;
  }
  return { value: winner.value, source: winner.paths[0] };
}

function indentVote(text: string): string | undefined {
  let tabs = 0;
  let spaces = 0;
  const widths: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const leading = /^([ \t]+)\S/.exec(line);
    if (!leading) {
      continue;
    }
    if (leading[1].includes('\t')) {
      tabs += 1;
    } else {
      spaces += 1;
      widths.push(leading[1].length);
    }
  }
  if (tabs + spaces < 1) {
    return undefined;
  }
  if (tabs > spaces) {
    return 'tabs';
  }
  if (spaces <= tabs || widths.length === 0) {
    return undefined;
  }
  const unit = Math.min(...widths);
  if (unit < 2 || widths.some((width) => width % unit !== 0)) {
    return undefined;
  }
  return `${unit} spaces`;
}

function quoteVote(text: string): string | undefined {
  let single = 0;
  let double = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(\/\/|#|\*|\/\*)/.test(raw)) {
      continue;
    }
    const line = raw.replace(/\s*\/\/.*$/, '');
    for (const char of line) {
      if (char === "'") {
        single += 1;
      } else if (char === '"') {
        double += 1;
      }
    }
  }
  const total = single + double;
  if (total < 2) {
    return undefined;
  }
  const winner = Math.max(single, double);
  if (winner / total < STRONG_MAJORITY) {
    return undefined;
  }
  return single > double ? 'single' : 'double';
}

function semicolonVote(text: string): 'yes' | 'no' | undefined {
  let yes = 0;
  let no = 0;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('#')) {
      continue;
    }
    line = line.replace(/\s*\/\/.*$/, '').trim();
    if (!line) {
      continue;
    }
    if (endsWithAny(line, ['{', '}', '(', ',', ':', '=', '=>', '&&', '||', '[', '.'])) {
      continue;
    }
    if (line.endsWith(';')) {
      yes += 1;
    } else if (/[A-Za-z0-9)\]'"`]$/.test(line)) {
      no += 1;
    }
  }
  const total = yes + no;
  if (total < 3) {
    return undefined;
  }
  const winner = Math.max(yes, no);
  if (winner / total < STRONG_MAJORITY) {
    return undefined;
  }
  return yes > no ? 'yes' : 'no';
}

function endsWithAny(value: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => value.endsWith(suffix));
}

interface StyleEvidence {
  indent?: { value: string; source: string };
  quotes?: { value: string; source: string };
}

function editorConfigStyles(text: string | undefined, path: string | undefined): StyleEvidence {
  if (!text || !path) {
    return {};
  }
  const sections = parseIni(text);
  const keys = new Map<string, string>();
  for (const section of ['', '*']) {
    for (const [key, value] of sections.get(section) ?? []) {
      keys.set(key, value);
    }
  }
  const evidence: StyleEvidence = {};
  const indentStyle = keys.get('indent_style')?.toLowerCase();
  const indentSize = keys.get('indent_size')?.toLowerCase();
  const tabWidth = keys.get('tab_width')?.toLowerCase();
  if (indentStyle === 'tab') {
    evidence.indent = { value: 'tabs', source: path };
  } else if (indentStyle === 'space') {
    const size = numeric(indentSize) ?? numeric(tabWidth);
    if (size) {
      evidence.indent = { value: `${size} spaces`, source: path };
    }
  }
  const quotes = keys.get('quote_type')?.toLowerCase() ?? keys.get('ij_javascript_single_quote')?.toLowerCase();
  if (quotes === 'single' || quotes === 'true') {
    evidence.quotes = { value: 'single', source: path };
  } else if (quotes === 'double' || quotes === 'false') {
    evidence.quotes = { value: 'double', source: path };
  }
  return evidence;
}

function numeric(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

interface PrettierStyleEvidence extends StyleEvidence {
  semicolons?: { value: string; source: string };
}

/** Read the style-relevant options from a JSON `.prettierrc`, when parseable. */
function prettierStyles(options: Record<string, unknown> | undefined, path: string | undefined): PrettierStyleEvidence {
  if (!options || !path) {
    return {};
  }
  const evidence: PrettierStyleEvidence = {};
  const useTabs = options.useTabs;
  const tabWidth = options.tabWidth;
  if (useTabs === true) {
    evidence.indent = { value: 'tabs', source: path };
  } else if (useTabs === false && typeof tabWidth === 'number' && tabWidth > 0) {
    evidence.indent = { value: `${tabWidth} spaces`, source: path };
  }
  if (options.singleQuote === true) {
    evidence.quotes = { value: 'single', source: path };
  } else if (options.singleQuote === false) {
    evidence.quotes = { value: 'double', source: path };
  }
  if (options.semi === true) {
    evidence.semicolons = { value: 'yes', source: path };
  } else if (options.semi === false) {
    evidence.semicolons = { value: 'no', source: path };
  }
  return evidence;
}

/* -------------------------------------------------------------------------- */
/* Test file patterns and naming                                              */
/* -------------------------------------------------------------------------- */

interface PatternTally {
  value: string;
  source: string;
}

function detectTestPattern(files: readonly string[]): PatternTally | undefined {
  const counts = new Map<string, { count: number; example: string }>();
  for (const path of files) {
    const pattern = classifyTestPath(path);
    if (!pattern) {
      continue;
    }
    const existing = counts.get(pattern);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(pattern, { count: 1, example: path });
    }
  }
  let winner: { value: string; tally: { count: number; example: string } } | undefined;
  for (const [value, tally] of counts) {
    if (!winner || tally.count > winner.tally.count) {
      winner = { value, tally };
    }
  }
  return winner ? { value: winner.value, source: winner.tally.example } : undefined;
}

function classifyTestPath(path: string): string | undefined {
  const normalized = normalizePath(path);
  const extension = extname(normalized);
  const inTests = /(^|\/)(__tests__|tests|test)\//i.test(normalized);
  if (JS_LIKE_EXTENSIONS.has(extension) && /\.test\.[a-z0-9]+$/i.test(normalized)) {
    return inTests ? `tests directory *.test${extension}` : `colocated *.test${extension}`;
  }
  if (JS_LIKE_EXTENSIONS.has(extension) && /\.spec\.[a-z0-9]+$/i.test(normalized)) {
    return inTests ? `tests directory *.spec${extension}` : `colocated *.spec${extension}`;
  }
  if (/\.py$/i.test(normalized) && /(^|\/)test_[^/]*\.py$/i.test(normalized)) {
    return inTests ? 'tests directory test_*.py' : 'colocated test_*.py';
  }
  if (/\.py$/i.test(normalized) && /_test\.py$/i.test(normalized)) {
    return inTests ? 'tests directory *_test.py' : 'colocated *_test.py';
  }
  if (/\.go$/i.test(normalized) && /_test\.go$/i.test(normalized)) {
    return 'colocated *_test.go';
  }
  if (/(^|\/)__tests__\//i.test(normalized)) {
    return 'tests directory __tests__/';
  }
  return undefined;
}

function classifyFileName(stem: string): string | undefined {
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(stem)) {
    return 'kebab-case';
  }
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(stem)) {
    return 'snake_case';
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) {
    return 'PascalCase';
  }
  if (/^[a-z][A-Za-z0-9]*$/.test(stem) && /[A-Z]/.test(stem)) {
    return 'camelCase';
  }
  return undefined;
}

function detectFileNaming(files: readonly string[]): PatternTally | undefined {
  const counts = new Map<string, { count: number; example: string }>();
  let total = 0;
  for (const path of files) {
    if (!isSourceFile(path) || isTestPath(path)) {
      continue;
    }
    const name = fileName(path);
    const dot = name.lastIndexOf('.');
    const style = classifyFileName(dot === -1 ? name : name.slice(0, dot));
    if (!style) {
      continue;
    }
    total += 1;
    const existing = counts.get(style);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(style, { count: 1, example: path });
    }
  }
  const winner = strongest(counts, total, 3);
  return winner ? { value: winner.value, source: winner.example } : undefined;
}

function detectComponentNaming(files: readonly string[]): PatternTally | undefined {
  let pascal = 0;
  let total = 0;
  let example = '';
  for (const path of files) {
    const extension = extname(path);
    if (!['.tsx', '.jsx'].includes(extension) || isTestPath(path)) {
      continue;
    }
    const name = fileName(path);
    const stem = name.slice(0, name.lastIndexOf('.'));
    total += 1;
    if (/^[A-Z][A-Za-z0-9]*$/.test(stem)) {
      pascal += 1;
      if (!example) {
        example = path;
      }
    }
  }
  if (total < 2 || pascal / total < STRONG_MAJORITY) {
    return undefined;
  }
  return { value: 'PascalCase', source: example };
}

function strongest(
  counts: Map<string, { count: number; example: string }>,
  total: number,
  minimum: number
): { value: string; example: string } | undefined {
  let winner: { value: string; example: string; count: number } | undefined;
  for (const [value, tally] of counts) {
    if (!winner || tally.count > winner.count) {
      winner = { value, example: tally.example, count: tally.count };
    }
  }
  if (!winner || total < minimum || winner.count / total < STRONG_MAJORITY) {
    return undefined;
  }
  return { value: winner.value, example: winner.example };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderFacts(facts: readonly ConventionFact[]): string {
  const lines = ['Conventions:'];
  for (const fact of facts) {
    lines.push(`- ${fact.label}: ${fact.value} (${fact.source})`);
  }
  return lines.join('\n');
}

function capText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false };
  }
  const marker = '\n(truncated)';
  const budget = Math.max(0, maxBytes - byteLength(marker));
  return { text: `${cutTextToBytes(value, budget)}${marker}`, truncated: true };
}

/**
 * Take a UTF-8 byte window without scanning the string once per character. The
 * buffer cut is moved back off a continuation byte, so a multi-byte code point
 * (including a surrogate pair, encoded as one 4-byte sequence) is never split.
 */
function cutTextToBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) {
    return value;
  }
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
