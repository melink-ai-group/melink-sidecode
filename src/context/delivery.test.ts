import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextDelivery } from './delivery.ts';
import { categoryExclusionKey } from './contextView.ts';
import type { ConventionSummary } from './conventions.ts';
import type {
  GetSnapshotInput,
  ProjectContextReads,
  ProjectDelta,
  ProjectSnapshot,
  ViewedFileAttachment
} from './projectContext.ts';

function snapshot(files: string[] = ['src/index.ts'], selectionText: string | null = null): ProjectSnapshot {
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
    instructions: {
      documents: [{ path: 'README.md', kind: 'readme', excerpt: '# App\n\nA test project.', truncated: false }],
      noneFound: false,
      truncated: null
    },
    editor: {
      active: selectionText
        ? {
            absolutePath: '/work/app/src/index.ts',
            relativePath: 'src/index.ts',
            languageId: 'typescript',
            selection: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 12, text: selectionText, truncated: false },
            excluded: false
          }
        : null,
      openEditors: [],
      dirtyFiles: [],
      terminalCwd: null,
      truncated: null
    },
    exclusions: { directories: [], patterns: [], user: [] },
    excludedPaths: [],
    truncated: null
  };
}

/** A fake snapshot source that can be made to fail or change on demand. */
class FakeReads implements ProjectContextReads {
  files: string[] = ['src/index.ts'];
  failNext = false;
  /** Mirrors the settings-driven inclusion of the selection text. */
  includeSelection = true;
  /** A counter so a test can prove the snapshot was actually rebuilt. */
  snapshotReads = 0;
  attachment?: ViewedFileAttachment;

  async viewedFileAttachment(): Promise<ViewedFileAttachment | undefined> {
    return this.attachment;
  }

  async getSnapshot(_input?: GetSnapshotInput): Promise<ProjectSnapshot> {
    this.snapshotReads += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('snapshot failed');
    }
    return snapshot(this.files, this.includeSelection ? 'const secret = 1;' : null);
  }

  async getDelta(previous: ProjectSnapshot, current?: ProjectSnapshot): Promise<ProjectDelta> {
    const next = current ?? (await this.getSnapshot());
    const added = next.shape.files.filter((file) => !previous.shape.files.includes(file));
    const removed = previous.shape.files.filter((file) => !next.shape.files.includes(file));
    if (added.length === 0 && removed.length === 0) {
      return { changed: false };
    }
    return { changed: true, files: { added, removed } };
  }
}

test('a new session primes with a full snapshot and its workspace root', async () => {
  const delivery = new ContextDelivery({ reads: new FakeReads() });
  const prime = await delivery.snapshot();
  assert.ok(prime.payload.snapshot);
  assert.equal(prime.payload.priming, true);
  assert.match(prime.payload.snapshot!, /Project name: app\./);
  assert.match(prime.payload.snapshot!, /Purpose \(from README\.md\): A test project\./);
  // The workspace root travels with the payload, so an adapter that spawns a
  // child uses the snapshot service's root rather than re-reading the host.
  assert.equal(prime.payload.workspaceRoot, '/work/app');
});

test('the stable snapshot prefix is re-sent every turn, with a delta when changed', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  delivery.begin('ollama:t1', await delivery.snapshot(), false);

  // First turn: snapshot + priming, no delta.
  const first = await delivery.forTurn('ollama:t1');
  assert.ok(first.snapshot);
  assert.equal(first.priming, true);
  assert.equal(first.delta, undefined);

  // Nothing changed: the stable prefix is still sent, but no delta.
  const second = await delivery.forTurn('ollama:t1');
  assert.equal(second.snapshot, first.snapshot);
  assert.equal(second.priming, false);
  assert.equal(second.delta, undefined);

  // A file added between turns appears as a compact delta, and the prefix is
  // unchanged, so it stays cacheable.
  reads.files = ['src/index.ts', 'src/new.ts'];
  const third = await delivery.forTurn('ollama:t1');
  assert.equal(third.snapshot, first.snapshot);
  assert.ok(third.delta);
  assert.match(third.delta!, /Files added: src\/new\.ts\./);
});

test('an adapter that consumed the snapshot natively is not marked priming on its first turn', async () => {
  const delivery = new ContextDelivery({ reads: new FakeReads() });
  delivery.begin('codex:t2', await delivery.snapshot(), true);

  const first = await delivery.forTurn('codex:t2');
  // The prefix is retained for the stateless contract, but the first turn is not
  // a session opener, so a per-turn adapter does not re-prime.
  assert.ok(first.snapshot);
  assert.equal(first.priming, false);

  const second = await delivery.forTurn('codex:t2');
  assert.equal(second.priming, false);
});

test('resume re-primes: a session opened again is marked priming again', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  delivery.begin('ollama:t3', await delivery.snapshot(), true);
  assert.equal((await delivery.forTurn('ollama:t3')).priming, false);

  // A resume is a new prime for the same thread key.
  const resumePrime = await delivery.snapshot();
  delivery.begin('ollama:t3', resumePrime, true);
  assert.match(resumePrime.payload.snapshot!, /Project name: app\./);
  // A native-primed adapter does not re-prime on the turn, but its prefix is the
  // resumed snapshot.
  const afterResume = await delivery.forTurn('ollama:t3');
  assert.equal(afterResume.snapshot, resumePrime.payload.snapshot);

  // A change after the resume is still reported as a delta.
  reads.files = ['src/index.ts', 'src/new.ts', 'src/third.ts'];
  const turn = await delivery.forTurn('ollama:t3');
  assert.ok(turn.delta);
  assert.match(turn.delta!, /Files added: src\/new\.ts, src\/third\.ts\./);
});

test('a failed snapshot degrades to a plain-language notice, never throwing', async () => {
  const reads = new FakeReads();
  reads.failNext = true;
  const delivery = new ContextDelivery({ reads });
  const prime = await delivery.snapshot();
  assert.equal(prime.payload.snapshot, undefined);
  assert.ok(prime.payload.notice);
  assert.equal(prime.payload.priming, true);
});

test('manual refresh re-arms priming and updates the stable prefix', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  delivery.begin('ollama:t4', await delivery.snapshot(), false);
  assert.equal((await delivery.forTurn('ollama:t4')).priming, true);
  assert.equal((await delivery.forTurn('ollama:t4')).priming, false);

  reads.files = ['src/index.ts', 'src/new.ts'];
  const refreshed = await delivery.refresh('ollama:t4');
  assert.ok(refreshed.snapshot);
  assert.match(refreshed.snapshot!, /Main languages: TypeScript \(2 files\)/);

  const turn = await delivery.forTurn('ollama:t4');
  assert.equal(turn.priming, true);
  assert.equal(turn.snapshot, refreshed.snapshot);
});

test('two threads do not share delivery state', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  delivery.begin('ollama:a', await delivery.snapshot(), true);
  delivery.begin('codex:b', await delivery.snapshot(), false);

  // Thread B still needs its prime; A does not.
  assert.equal((await delivery.forTurn('ollama:a')).priming, false);
  assert.equal((await delivery.forTurn('codex:b')).priming, true);
});

test('a context-setting change re-primes an open thread so the next turn drops the old selection', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });

  // The viewed file is attached, so the selection rides on the per-turn block
  // and never in the stable prefix.
  reads.includeSelection = true;
  reads.attachment = {
    path: 'src/index.ts',
    languageId: 'typescript',
    excluded: false,
    text: 'const value = 1;',
    selection: 'const secret = 1;'
  };
  delivery.setIncludeViewedFile(true);
  delivery.begin('ollama:t9', await delivery.snapshot(), false);
  const before = await delivery.forTurn('ollama:t9');
  assert.match(before.attachedFile!, /const secret = 1;/);
  assert.doesNotMatch(before.snapshot!, /const secret = 1;/);

  // The user turns selection sharing off and saves. The next turn must not
  // keep shipping the selected text, and the prefix is rebuilt.
  reads.includeSelection = false;
  reads.attachment = { ...reads.attachment, selection: undefined };
  reads.files = ['src/index.ts', 'src/after.ts'];
  delivery.invalidateAll();

  const after = await delivery.forTurn('ollama:t9');
  assert.match(after.snapshot!, /Project name/);
  assert.doesNotMatch(after.attachedFile ?? '', /const secret = 1;/);
  assert.doesNotMatch(after.snapshot!, /const secret = 1;/);
  assert.equal(after.priming, true);

  // The prefix really was rebuilt, not merely re-sent.
  assert.notEqual(after.snapshot, before.snapshot);
});

test('the viewed file stays out of the snapshot until the user attaches it', async () => {
  const reads = new FakeReads();
  reads.includeSelection = true;
  reads.attachment = {
    path: 'frontend/src/styles/global.css',
    languageId: 'css',
    excluded: false,
    text: 'body { margin: 0; }'
  };
  const delivery = new ContextDelivery({ reads });
  const prime = await delivery.snapshot();
  assert.match(prime.payload.snapshot!, /not attached/i);
  assert.doesNotMatch(prime.payload.snapshot!, /global\.css/);
  assert.match(prime.payload.attachedFile!, /not attached/i);
  assert.match(prime.payload.attachedFile!, /<attached-file>/);

  delivery.setIncludeViewedFile(true);
  const turned = await delivery.forTurn('ollama:viewed');
  assert.match(turned.attachedFile!, /frontend\/src\/styles\/global\.css/);
  assert.match(turned.attachedFile!, /body \{ margin: 0; \}/);
  assert.match(turned.snapshot!, /separate block/);
  assert.doesNotMatch(turned.snapshot!, /global\.css/);
});

test('invalidateAll re-arms every thread and is safe when no thread is open', async () => {
  const reads = new FakeReads();
  const delivery = new ContextDelivery({ reads });
  // No thread primed yet: invalidating is a no-op, not a crash.
  delivery.invalidateAll();

  reads.includeSelection = true;
  delivery.begin('ollama:a', await delivery.snapshot(), false);
  delivery.begin('codex:b', await delivery.snapshot(), true);
  assert.equal((await delivery.forTurn('ollama:a')).priming, true);

  reads.includeSelection = false;
  delivery.invalidateAll();

  // Both threads rebuild and both are marked priming again, so a stateful
  // adapter re-consumes the corrected snapshot rather than assuming the old one.
  const a = await delivery.forTurn('ollama:a');
  const b = await delivery.forTurn('codex:b');
  assert.equal(a.priming, true);
  assert.equal(b.priming, true);
  assert.doesNotMatch(a.snapshot!, /const secret = 1;/);
  assert.doesNotMatch(b.snapshot!, /const secret = 1;/);
});

function conventions(): ConventionSummary {
  const text = 'Conventions:\n- Formatter: Prettier (.prettierrc)';
  return {
    text,
    facts: [{ label: 'Formatter', value: 'Prettier', source: '.prettierrc' }],
    truncated: false,
    bytes: Buffer.byteLength(text, 'utf8'),
    samplesRead: 1
  };
}

class ConventionsReads extends FakeReads {
  override async getSnapshot(input?: GetSnapshotInput): Promise<ProjectSnapshot> {
    return { ...(await super.getSnapshot(input)), conventions: conventions() };
  }
}

test('excluding the shape category removes the conventions block from delivery', async () => {
  const delivery = new ContextDelivery({ reads: new ConventionsReads() });
  const plain = await delivery.snapshot();
  assert.match(plain.payload.snapshot!, /Conventions:/);

  delivery.setExclusions([categoryExclusionKey('shape')]);
  const excluded = await delivery.snapshot();
  assert.doesNotMatch(excluded.payload.snapshot!, /Conventions:/);
});
