/** Build `ast-grep` CLI argv for MCP tool calls. Pure; safe for unit tests. */

export function buildSearchArgs(args: Record<string, unknown>): string[] {
  const pattern = stringArg(args.pattern);
  if (!pattern) {
    throw new Error('search requires a pattern.');
  }
  const out = ['run', '-p', pattern, '--json=compact'];
  const lang = stringArg(args.lang);
  if (lang) {
    out.push('-l', lang);
  }
  const context = numberArg(args.context);
  if (context !== undefined) {
    out.push('-C', String(context));
  }
  for (const glob of stringArray(args.globs)) {
    out.push('--globs', glob);
  }
  const paths = stringArray(args.paths);
  if (paths.length > 0) {
    out.push(...paths);
  } else {
    out.push('.');
  }
  return out;
}

export function buildReplaceArgs(args: Record<string, unknown>): string[] {
  const pattern = stringArg(args.pattern);
  if (!pattern || typeof args.rewrite !== 'string') {
    throw new Error('replace requires pattern and rewrite.');
  }
  const dryRun = args.dryRun !== false;
  const paths = stringArray(args.paths);
  if (!dryRun) {
    // A write is never silent: the caller must opt in to applying the change
    // *and* name the files or directories. Without both, a model could rewrite
    // the whole workspace with one pre-approved call.
    if (args.approve !== true) {
      throw new Error(
        'replace writes files only with approve: true. Preview with dryRun (the default) first, then name the paths to rewrite.'
      );
    }
    if (paths.length === 0) {
      throw new Error('replace writes files only with explicit paths inside the workspace.');
    }
  }
  const out = ['run', '-p', pattern, '-r', args.rewrite];
  if (dryRun) {
    out.push('--json=compact');
  } else {
    out.push('--update-all');
  }
  const lang = stringArg(args.lang);
  if (lang) {
    out.push('-l', lang);
  }
  for (const glob of stringArray(args.globs)) {
    out.push('--globs', glob);
  }
  if (paths.length > 0) {
    out.push(...paths);
  } else {
    out.push('.');
  }
  return out;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}
