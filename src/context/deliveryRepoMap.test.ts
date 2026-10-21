import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextDelivery } from './delivery.ts';
import type {
  GetSnapshotInput,
  ProjectContextReads,
  ProjectDelta,
  ProjectSnapshot
} from './projectContext.ts';
import type { ContextSettings } from './contextSettings.ts';
import {
  DEFAULT_CONTEXT_SETTINGS
} from './contextSettings.ts';
import { REPO_MAP_DISABLED, REPO_MAP_EMPTY, REPO_MAP_FAILED, REPO_MAP_UNAVAILABLE } from './repoMap.ts';

function snapshot(files: string[], dirtyFiles: string[] = []): ProjectSnapshot {
  return {
    timestamp: 1_000,
    workspace: {
      names: ['app'],
      roots: ['/work/app'],
      multiRoot: false,
      isGitRepo: false,
      branch: null,
      remote: null,
      truncated: null
    },
    shape: {
      languages: [{ language: 'TypeScript', files: files.length }],
      tree: [],
      manifests: [],
      files,
      totalFiles: files.length,
      languagesTruncated: false,
      truncated: null
    },
    instructions: { documents: [], noneFound: true, truncated: null },
    editor: {
      active: null,
      openEditors: [],
      dirtyFiles,
      terminalCwd: null,
      truncated: null
    },
    exclusions: { directories: [], patterns: [], user: [] },
    excludedPaths: [],
    truncated: null
  };
}

class FakeReads implements ProjectContextReads {
  files: string[] = ['src/auth.ts', 'src/app.ts'];
  dirty: string[] = [];
  failSnapshot = false;
  failReads = 0;
  readCount = 0;
  contents: Record<string, string> = {
    'src/auth.ts': 'export function login() {}\nexport function logout() {}',
    'src/app.ts': "import { login } from './auth';\nexport function main() { login(); }"
  };
  settings: ContextSettings = {
    ...DEFAULT_CONTEXT_SETTINGS,
    repoMap: true
  };

  contextSettings(): ContextSettings {
    return this.settings;
  }

  async readFile(path: string): Promise<string | undefined> {
    this.readCount += 1;
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error('transient read failure');
    }
    return this.contents[path.replace(/^\/work\/app\//, '')];
  }

  async getSnapshot(_input?: GetSnapshotInput): Promise<ProjectSnapshot> {
    if (this.failSnapshot) {
      throw new Error('snapshot failed');
    }
    return snapshot(this.files, this.dirty);
  }

  async getDelta(previous: ProjectSnapshot, current?: ProjectSnapshot): Promise<ProjectDelta> {
    const next = current ?? (await this.getSnapshot());
    const changed = previous.shape.files.join('|') !== next.shape.files.join('|');
    return { changed };
  }
}

test('an enabled repo map is present and ranked by the user request', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  const turn = await delivery.forTurn('ollama:repo', {}, 'implement login');

  assert.ok(turn.snapshot);
  assert.ok(turn.repoMap);
  assert.match(turn.repoMap!, /src\/auth\.ts: login, logout/);
  assert.match(turn.repoMap!, /src\/app\.ts/);
  assert.notEqual(turn.repoMap, REPO_MAP_DISABLED);
});

test('the repo map is off by default and sends the disabled marker, not data', async () => {
  const reads = new FakeReads();
  reads.settings = { ...DEFAULT_CONTEXT_SETTINGS };
  const delivery = new ContextDelivery({ reads });
  const turn = await delivery.forTurn('ollama:off', {}, 'implement login');

  assert.equal(turn.repoMap, REPO_MAP_DISABLED);
  assert.equal(turn.repoMap?.includes('src/auth.ts'), false);
  assert.equal(reads.readCount, 0);
  // Snapshot and delta behavior is unchanged by the off map.
  assert.ok(turn.snapshot);
});

test('an absent snapshot makes the repo map explicitly unavailable', async () => {
  const reads = new FakeReads();
  reads.failSnapshot = true;
  const delivery = new ContextDelivery({ reads });
  const turn = await delivery.forTurn('ollama:nosnapshot', {}, 'login');

  assert.equal(turn.snapshot, undefined);
  assert.equal(turn.repoMap, REPO_MAP_UNAVAILABLE);
});

test('a failing file read becomes a failed marker, never a blocked turn', async () => {
  const reads = new FakeReads();
  reads.readFile = async () => {
    throw new Error('read failed');
  };
  const delivery = new ContextDelivery({ reads });
  const turn = await delivery.forTurn('ollama:failed', {}, 'login');

  assert.equal(turn.repoMap, REPO_MAP_FAILED);
  assert.ok(turn.snapshot);
});

test('a limited map with no query match keeps both the limited and empty markers', async () => {
  const reads = new FakeReads();
  reads.settings = { ...DEFAULT_CONTEXT_SETTINGS, repoMap: true, repoMapMaxFiles: 1 };
  const delivery = new ContextDelivery({ reads });
  // Files sort to app.ts first; the only 'login' definition (auth.ts) is beyond
  // the one-file cap, so the query matches nothing in a partial index.
  const turn = await delivery.forTurn('ollama:limited', {}, 'login');

  assert.match(turn.repoMap!, /Repo map: limited/);
  assert.match(turn.repoMap!, /no matching files for this request/);
  assert.notEqual(turn.repoMap, REPO_MAP_EMPTY);
});

test('the map is cached per accepted file list, retries failures, and every reset clears it', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  await delivery.forTurn('ollama:cache', {}, 'login');
  const afterFirst = reads.readCount;
  assert.ok(afterFirst > 0);

  await delivery.forTurn('ollama:cache', {}, 'logout');
  assert.equal(reads.readCount, afterFirst);

  // A changed file list is a new snapshot key and rebuilds.
  reads.files = ['src/auth.ts', 'src/app.ts', 'src/new.ts'];
  reads.contents['src/new.ts'] = 'export function fresh() {}';
  await delivery.forTurn('ollama:cache', {}, 'fresh');
  assert.ok(reads.readCount > afterFirst);

  // The manual/settings reset drops the cached index as well.
  const beforeReset = reads.readCount;
  delivery.invalidateAll();
  await delivery.forTurn('ollama:cache', {}, 'login');
  assert.ok(reads.readCount > beforeReset);

  // A failed build is not cached, so the next turn retries and recovers.
  delivery.invalidateAll();
  reads.failReads = 1;
  const failed = await delivery.forTurn('ollama:cache', {}, 'login');
  assert.equal(failed.repoMap, REPO_MAP_FAILED);
  const recovered = await delivery.forTurn('ollama:cache', {}, 'login');
  assert.match(recovered.repoMap!, /src\/auth\.ts/);

  // refresh() and setExclusions() both drop the cached index.
  const beforeRefresh = reads.readCount;
  await delivery.refresh('ollama:cache');
  await delivery.forTurn('ollama:cache', {}, 'login');
  assert.ok(reads.readCount > beforeRefresh);

  const beforeExclusions = reads.readCount;
  delivery.setExclusions([]);
  await delivery.forTurn('ollama:cache', {}, 'login');
  assert.ok(reads.readCount > beforeExclusions);
});

test('dirty files rank related entries when the request has no words', async () => {
  const reads = new FakeReads();
  reads.dirty = ['src/app.ts'];
  const delivery = new ContextDelivery({ reads });
  const turn = await delivery.forTurn('ollama:dirty');

  assert.match(turn.repoMap!.split('\n')[0], /^src\/app\.ts/);
});
