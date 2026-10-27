import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function stageDictation() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'stage-dictation.mjs')], {
      cwd: root,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`stage-dictation exited with ${code}`));
      }
    });
  });
}

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  legalComments: 'none'
};

/** Extension host bundle: CommonJS, `vscode` stays external. */
/** @type {import('esbuild').BuildOptions} */
const extensionOptions = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'playwright-core'],
  // The browser panel cannot load extension-relative CSS, so its inline token
  // block is the source stylesheet embedded at build time.
  loader: { '.css': 'text' }
};

/** Webview bundle: React + TypeScript, browser IIFE, CSS emitted alongside. */
/** @type {import('esbuild').BuildOptions} */
const webviewOptions = {
  ...shared,
  entryPoints: ['src/webview/index.tsx'],
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'css', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') }
};

/** Plan document view: rendered markdown plus the Build action. */
/** @type {import('esbuild').BuildOptions} */
const planPreviewOptions = {
  ...shared,
  entryPoints: ['src/webview/planPreview.tsx'],
  outfile: 'dist/planPreview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') }
};

/** Browser MCP shim: stdio only. It forwards tool calls and does not launch a browser. */
/** @type {import('esbuild').BuildOptions} */
const browserMcpOptions = {
  ...shared,
  entryPoints: ['src/browser/mcp.ts'],
  outfile: 'dist/browser-mcp.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20'
};

/** ast-grep MCP shim: stdio only. Shells out to the resolved ast-grep CLI. */
/** @type {import('esbuild').BuildOptions} */
const astGrepMcpOptions = {
  ...shared,
  entryPoints: ['src/astGrep/mcp.ts'],
  outfile: 'dist/ast-grep-mcp.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20'
};

const targets = [extensionOptions, webviewOptions, planPreviewOptions, browserMcpOptions, astGrepMcpOptions];

if (watch) {
  await stageDictation();
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching extension host and webview');
} else {
  await Promise.all(targets.map((options) => build(options)));
  await stageDictation();
  console.log(`[esbuild] built dist/extension.js, dist/webview.{js,css}, dist/planPreview.{js,css}, dist/browser-mcp.js, and dist/ast-grep-mcp.js (${production ? 'production' : 'development'})`);
}
