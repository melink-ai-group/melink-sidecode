import { commandNotFound } from '../launch.ts';
import type { SpawnOutcome } from './zvecGrep.ts';

/**
 * zvec-grep index state and the explicit "Build index" action.
 *
 * A zvec search against a workspace with no index answers `INDEX_MISSING`.
 * SideCode never indexes on its own: indexing reads the workspace and writes
 * `.zvec-grep/`, so it only runs when the user presses **Build index**.
 */

export type ZvecIndexState = 'ready' | 'missing' | 'building' | 'unknown';

/** A runner that can set the workspace as the child's working directory. */
export type IndexRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd?: string
) => Promise<SpawnOutcome>;

export const ZVEC_INDEX_TIMEOUT_MS = 180_000;

/** Read the state line `zg status` prints, without its terminal colours. */
export function parseZvecIndexState(output: string): ZvecIndexState {
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/workspace index is ready/i.test(text)) {
    return 'ready';
  }
  if (/workspace index is (updating|being built)|indexing in progress/i.test(text)) {
    return 'building';
  }
  if (/workspace index is not (created|configured)|INDEX_MISSING/i.test(text)) {
    return 'missing';
  }
  return 'unknown';
}

/** One plain sentence the panel can show for an index state. */
export function zvecIndexGuidance(state: ZvecIndexState): string {
  if (state === 'ready') {
    return 'The workspace index is ready; semantic search can return results.';
  }
  if (state === 'missing') {
    return 'zvec-grep needs a workspace index. Press Build index once per workspace; without one, searches return INDEX_MISSING.';
  }
  if (state === 'building') {
    return 'The workspace index is being built. Searches may be incomplete until it finishes.';
  }
  return 'The workspace index state could not be read. Run zg status in this workspace for details.';
}

const INDEX_CACHE_TTL_MS = 30_000;
const indexCache = new Map<string, { at: number; state: ZvecIndexState }>();

/** Status probe, cached briefly because the settings snapshot reads it. */
export async function readZvecIndexState(
  run: IndexRunner,
  command: string,
  cwd: string,
  options: { cache?: boolean } = {}
): Promise<ZvecIndexState> {
  const key = `${command}\u0000${cwd}`;
  const cached = indexCache.get(key);
  const now = Date.now();
  if (options.cache !== false && cached && now - cached.at < INDEX_CACHE_TTL_MS) {
    return cached.state;
  }
  const result = await run(command, ['status'], 15_000, cwd);
  const state =
    result.error || commandNotFound(result)
      ? 'unknown'
      : parseZvecIndexState(`${result.stdout}\n${result.stderr}`);
  indexCache.set(key, { at: now, state });
  return state;
}

/** Forget a cached state after a build or a config change. */
export function forgetZvecIndexState(command?: string, cwd?: string): void {
  if (!command || !cwd) {
    indexCache.clear();
    return;
  }
  indexCache.delete(`${command}\u0000${cwd}`);
}

export interface ZvecIndexBuildResult {
  ok: boolean;
  state: ZvecIndexState;
  message: string;
}

/** Run the supported `zg index` command once, in the workspace. */
export async function buildZvecIndex(options: {
  run: IndexRunner;
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<ZvecIndexBuildResult> {
  const result = await options.run(
    options.command,
    ['index'],
    options.timeoutMs ?? ZVEC_INDEX_TIMEOUT_MS,
    options.cwd
  );
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error === 'timeout') {
    return {
      ok: false,
      state: 'unknown',
      message:
        'Building the index took too long and was stopped. Indexing a large workspace can exceed three minutes; run `zg index` in a terminal and press Test afterwards.'
    };
  }
  if (result.error === 'missing' || commandNotFound(result)) {
    return {
      ok: false,
      state: 'unknown',
      message: 'zg was not found, so the workspace index was not built. Install zvec-grep or fix its path first.'
    };
  }
  if (result.code !== 0) {
    forgetZvecIndexState(options.command, options.cwd);
    const state = await readZvecIndexState(options.run, options.command, options.cwd, {
      cache: false
    });
    return {
      ok: false,
      state,
      message: indexFailureMessage(output)
    };
  }

  forgetZvecIndexState(options.command, options.cwd);
  const state = await readZvecIndexState(options.run, options.command, options.cwd, { cache: false });
  if (state === 'ready') {
    return { ok: true, state, message: 'Workspace index is ready. Semantic search can return results.' };
  }
  if (state === 'missing') {
    return {
      ok: false,
      state,
      message:
        'The index command finished, but no workspace index exists yet. Check the command output, then press Build index again.'
    };
  }
  return {
    ok: true,
    state,
    message:
      state === 'building'
        ? 'Indexing started. The workspace index is still being built; press Test in a moment.'
        : 'The index command finished. Press Test to confirm the workspace index state.'
  };
}

function indexFailureMessage(output: string): string {
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (/--embedding|embedding model|configured default|ZVEC_GREP_EMBEDDING/i.test(text)) {
    return 'No embedding model is configured for a new index. Run `zg config model set <model> --default` (or set ZVEC_GREP_EMBEDDING), then press Build index again.';
  }
  const line = lastUsefulLine(text);
  return line.length > 0
    ? `The workspace index was not built: ${line}`
    : 'The workspace index was not built. Check that zg can read this workspace, then try again.';
}

function lastUsefulLine(value: string): string {
  const lines = value
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
  const line = lines[lines.length - 1] ?? '';
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}
