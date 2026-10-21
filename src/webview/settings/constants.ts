/**
 * The built-in ignore patterns shown for reference. They mirror the documented
 * default set in `docs/usage.md`; they are not editable, because the built-in
 * secret and key exclusions are always on.
 */
export const CONTEXT_BUILTIN_PATTERNS: readonly string[] = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'coverage/',
  '*.min.js',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  '.env',
  '*.pem',
  '*.key',
  'id_rsa'
];
