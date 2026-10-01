import { build, context } from 'esbuild';

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
  external: ['vscode']
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
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') }
};

const targets = [extensionOptions, webviewOptions];

if (watch) {
  const contexts = await Promise.all(targets.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching extension host and webview');
} else {
  await Promise.all(targets.map((options) => build(options)));
  console.log(`[esbuild] built dist/extension.js and dist/webview.{js,css} (${production ? 'production' : 'development'})`);
}
