import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CheckHost, CHECK_PROCESS_OUTPUT_LIMIT, type CheckManifest } from './checkHost.ts';
import { CheckStore, type CheckStoreMemento } from './checkStore.ts';
import { decisionBlockReason } from './checkGate.ts';
import type { ResolvedCheckSettings } from './checkSettings.ts';
import type { CheckProcess, CheckRunView } from './checks.ts';

class FakeMemento implements CheckStoreMemento {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function resolved(
  code: number | null,
  stdout = '',
  stderr = '',
  error?: string
): CheckProcess {
  return {
    promise: Promise.resolve({
      code,
      stdout,
      stderr,
      ...(error !== undefined ? { error } : {})
    }),
    kill: () => undefined
  };
}

function pending(): {
  process: CheckProcess;
  resolve: (value: { code: number | null; stdout: string; stderr: string }) => void;
  killed: () => boolean;
} {
  const result = deferred<{ code: number | null; stdout: string; stderr: string }>();
  let killed = false;
  return {
    process: {
      promise: result.promise,
      kill: () => {
        killed = true;
      }
    },
    resolve: result.resolve,
    killed: () => killed
  };
}

interface HarnessOptions {
  settings?: Partial<ResolvedCheckSettings>;
  manifest?: CheckManifest | undefined;
  known?: boolean;
  active?: boolean;
  spawn?: (command: string) => CheckProcess;
  onManifestRead?: () => void;
  manifestGate?: Promise<void>;
}

function harness(options: HarnessOptions = {}): {
  host: CheckHost;
  store: CheckStore;
  updates: CheckRunView[];
  commands: string[];
  cwds: string[];
  settings: ResolvedCheckSettings;
} {
  const memento = new FakeMemento();
  let clock = 0;
  const store = new CheckStore(memento, () => {
    clock += 1;
    return clock;
  });
  const updates: CheckRunView[] = [];
  const commands: string[] = [];
  const cwds: string[] = [];
  const settings: ResolvedCheckSettings = {
    enabled: true,
    timeoutMs: 1_000,
    trusted: true,
    ...options.settings
  };
  const host = new CheckHost({
    store,
    readSettings: () => settings,
    workspaceRoot: () => 'C:/repo',
    readManifest: async () => {
      options.onManifestRead?.();
      if (options.manifestGate) {
        await options.manifestGate;
      }
      return options.manifest ?? { scripts: { test: 'node --test' } };
    },
    spawn: (command, spawnOptions) => {
      commands.push(command);
      cwds.push(spawnOptions.cwd);
      return options.spawn ? options.spawn(command) : resolved(0, 'ok');
    },
    isKnownTurn: () => options.known ?? true,
    isActiveTurn: () => options.active ?? true,
    now: () => {
      clock += 1;
      return clock;
    }
  });
  return { host, store, updates, commands, cwds, settings };
}

function startInput(
  host: CheckHost,
  updates: CheckRunView[],
  turnId: string,
  hasChanges = true,
  onUpdate?: (view: CheckRunView) => void
): Promise<void> {
  return host.startTurnChecks({
    backendId: 'codex',
    threadId: 'thread',
    turnId,
    hasChanges,
    onUpdate:
      onUpdate ??
      ((view) => {
        updates.push(view);
      })
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('a run stores running, posts running, then stores and posts the final view', async () => {
  let storedWhileRunning: string | undefined;
  const { host, store, updates, commands, cwds } = harness();
  const onUpdate = (view: CheckRunView): void => {
    updates.push(view);
    if (view.status === 'running') {
      storedWhileRunning = store.get('codex', 'thread', 'turn')?.status;
    }
  };

  await startInput(host, updates, 'turn', true, onUpdate);

  assert.deepEqual(
    updates.map((view) => view.status),
    ['running', 'passed']
  );
  assert.equal(storedWhileRunning, 'running');
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'passed');
  assert.deepEqual(commands, ['npm run test']);
  assert.deepEqual(cwds, ['C:/repo']);
});

test('checks are skipped without changes, for an unknown turn, or when already offered', async () => {
  const first = harness();
  await startInput(first.host, first.updates, 'turn', false);
  assert.equal(first.commands.length, 0);
  assert.equal(first.store.get('codex', 'thread', 'turn'), undefined);

  const unknown = harness({ known: false });
  await startInput(unknown.host, unknown.updates, 'turn');
  assert.equal(unknown.commands.length, 0);
  assert.equal(unknown.store.get('codex', 'thread', 'turn'), undefined);

  const duplicate = harness();
  await startInput(duplicate.host, duplicate.updates, 'turn');
  await startInput(duplicate.host, duplicate.updates, 'turn');
  assert.equal(duplicate.commands.length, 1);
  assert.equal(duplicate.updates.filter((view) => view.status === 'running').length, 1);
});

test('the orchestration gate can disable a run without spawning or storing anything', async () => {
  const { host, store, updates, commands } = harness();
  await host.startTurnChecks({
    backendId: 'codex',
    threadId: 'thread',
    turnId: 'turn',
    hasChanges: true,
    shouldRun: false
  });

  assert.equal(commands.length, 0);
  assert.equal(store.get('codex', 'thread', 'turn'), undefined);
  assert.deepEqual(updates, []);
});

test('the resolved orchestration value overrides the legacy enabled flag', async () => {
  // New true + legacy false: the takeover the Orchestration screen promises.
  const takeover = harness({ settings: { enabled: false } });
  await takeover.host.startTurnChecks({
    backendId: 'codex',
    threadId: 'thread',
    turnId: 'turn1',
    hasChanges: true,
    enabledOverride: true
  });
  assert.deepEqual(takeover.commands, ['npm run test']);
  assert.equal(takeover.store.get('codex', 'thread', 'turn1')?.status, 'passed');

  // New false + legacy true: the new explicit value still wins.
  const newOff = harness({ settings: { enabled: true } });
  await newOff.host.startTurnChecks({
    backendId: 'codex',
    threadId: 'thread',
    turnId: 'turn2',
    hasChanges: true,
    enabledOverride: false
  });
  assert.equal(newOff.commands.length, 0);
  assert.equal(newOff.store.get('codex', 'thread', 'turn2')?.status, 'skipped');
  assert.equal(newOff.store.get('codex', 'thread', 'turn2')?.summary, 'Checks are disabled.');

  // No override: the legacy reader (true here) still runs the checks.
  const legacyOn = harness({ settings: { enabled: true } });
  await startInput(legacyOn.host, legacyOn.updates, 'turn3');
  assert.deepEqual(legacyOn.commands, ['npm run test']);
});

test('an untrusted workspace stores and posts the untrusted result without spawning', async () => {
  let manifestReads = 0;
  const { host, store, updates, commands } = harness({
    settings: { trusted: false },
    onManifestRead: () => {
      manifestReads += 1;
    }
  });
  await startInput(host, updates, 'turn');

  assert.equal(commands.length, 0);
  assert.equal(manifestReads, 0);
  assert.equal(updates[0]?.status, 'untrusted');
  assert.equal(updates[0]?.summary, 'Checks skipped: workspace is untrusted.');
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'untrusted');
});

test('disabled and explicitly empty command lists are off without spawning', async () => {
  const disabled = harness({ settings: { enabled: false } });
  await startInput(disabled.host, disabled.updates, 'turn1');
  assert.equal(disabled.commands.length, 0);
  assert.equal(disabled.store.get('codex', 'thread', 'turn1')?.status, 'skipped');
  assert.equal(disabled.store.get('codex', 'thread', 'turn1')?.summary, 'Checks are disabled.');

  const empty = harness({ settings: { commands: [] } });
  await startInput(empty.host, empty.updates, 'turn2');
  assert.equal(empty.commands.length, 0);
  assert.equal(empty.store.get('codex', 'thread', 'turn2')?.summary, 'Checks disabled by configuration.');
});

test('no matching scripts is reported as no-scripts rather than spawning', async () => {
  const { host, store, updates, commands } = harness({ manifest: { scripts: { build: 'esbuild' } } });
  await startInput(host, updates, 'turn');

  assert.equal(commands.length, 0);
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'skipped');
  assert.match(store.get('codex', 'thread', 'turn')?.summary ?? '', /no typecheck, lint, or test script/i);
});

test('explicit commands run verbatim, and auto-detection uses the manifest package manager', async () => {
  const explicit = harness({ settings: { commands: ['npm run build'] }, manifest: { scripts: {} } });
  await startInput(explicit.host, explicit.updates, 'turn1');
  assert.deepEqual(explicit.commands, ['npm run build']);

  const detected = harness({
    manifest: { scripts: { lint: 'eslint', test: 'node --test' }, packageManager: 'yarn@4.1.0' }
  });
  await startInput(detected.host, detected.updates, 'turn2');
  assert.deepEqual(detected.commands, ['yarn run lint', 'yarn run test']);
});

test('a spawn failure is stored as an error result, not thrown', async () => {
  const { host, store, updates } = harness({
    spawn: () => {
      throw new Error('spawn refused');
    }
  });
  await startInput(host, updates, 'turn');

  const stored = store.get('codex', 'thread', 'turn');
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.results[0]?.status, 'error');
  assert.equal(stored?.results[0]?.reason, 'spawn refused');
});

test('captured output is bounded before it reaches the stored result', async () => {
  const { host, store, updates } = harness({
    spawn: () =>
      resolved(0, 'x'.repeat(CHECK_PROCESS_OUTPUT_LIMIT * 2), 'y'.repeat(CHECK_PROCESS_OUTPUT_LIMIT + 100))
  });
  await startInput(host, updates, 'turn');

  const output = store.get('codex', 'thread', 'turn')?.results[0]?.output ?? '';
  assert.ok(output.length <= 4_000);
  assert.ok(output.startsWith('…'));
  assert.ok(output.endsWith('y'));
});

test('a background turn stores the final result but never posts to the active surface', async () => {
  const { host, store, updates } = harness({ active: false });
  await startInput(host, updates, 'turn');

  assert.equal(updates.length, 0);
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'passed');
});

test('cancel kills the child, stores skipped, and late results are ignored', async () => {
  let process: ReturnType<typeof pending> | undefined;
  const { host, store, updates } = harness({
    spawn: () => {
      process = pending();
      return process.process;
    }
  });

  const run = startInput(host, updates, 'turn');
  await waitFor(() => process !== undefined, 'spawn');
  await waitFor(() => store.get('codex', 'thread', 'turn')?.status === 'running', 'running store');

  await host.cancelThread('codex', 'thread');
  await waitFor(() => process?.killed() === true, 'kill');
  assert.equal(process?.killed(), true);
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'skipped');
  assert.match(store.get('codex', 'thread', 'turn')?.summary ?? '', /Superseded by a newer turn/);
  assert.equal(store.get('codex', 'thread', 'turn')?.results[0]?.reason, 'Superseded by a newer turn.');

  process?.resolve({ code: 0, stdout: 'late', stderr: '' });
  await run;
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'skipped');
  assert.equal(store.get('codex', 'thread', 'turn')?.results.some((entry) => entry.status === 'passed'), false);
});

test('cancel during the manifest read stores skipped instead of leaving a spinner', async () => {
  const gate = deferred<void>();
  let manifestReads = 0;
  const { host, store, updates, commands } = harness({
    manifestGate: gate.promise,
    onManifestRead: () => {
      manifestReads += 1;
    }
  });

  const run = startInput(host, updates, 'turn');
  await waitFor(() => manifestReads === 1, 'manifest read');
  await host.cancelThread('codex', 'thread');
  gate.resolve(undefined);
  await run;

  assert.equal(commands.length, 0);
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'skipped');
  assert.equal(store.get('codex', 'thread', 'turn')?.results[0]?.reason, 'Superseded by a newer turn.');
  assert.equal(updates.some((view) => view.status === 'passed'), false);
});

test('a newer turn on the same thread supersedes the previous run', async () => {
  const first = pending();
  let call = 0;
  const { host, store, updates, settings } = harness({
    spawn: () => {
      call += 1;
      return call === 1 ? first.process : resolved(0, 'second');
    }
  });
  assert.equal(settings.trusted, true);

  const runFirst = startInput(host, updates, 'turn1');
  await waitFor(() => call === 1, 'first spawn');
  await waitFor(() => store.get('codex', 'thread', 'turn1')?.status === 'running', 'first running');

  const runSecond = startInput(host, updates, 'turn2');
  await runSecond;
  await runFirst;

  assert.equal(first.killed(), true);
  assert.equal(store.get('codex', 'thread', 'turn1')?.status, 'skipped');
  assert.equal(store.get('codex', 'thread', 'turn2')?.status, 'passed');
  assert.equal(call, 2);
});

test('a starting state is stored and posted before the manifest read, so Keep is gated', async () => {
  const gate = deferred<void>();
  let manifestReads = 0;
  const { host, store, updates } = harness({
    manifestGate: gate.promise,
    onManifestRead: () => {
      manifestReads += 1;
    }
  });

  const run = startInput(host, updates, 'turn');
  await waitFor(() => manifestReads === 1, 'manifest read');

  const starting = store.get('codex', 'thread', 'turn');
  assert.equal(starting?.status, 'running');
  assert.equal(starting?.summary, 'Checks starting…');
  assert.equal(updates[0]?.summary, 'Checks starting…');
  assert.equal(
    decisionBlockReason(starting, false),
    'Checks are still running. Keep is disabled until they finish.'
  );

  gate.resolve(undefined);
  await run;

  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'passed');
  assert.equal(updates.at(-1)?.status, 'passed');
});

test('two overlapping starts on one thread run once and never lose the newer final state', async () => {
  const gate = deferred<void>();
  const { host, store, commands } = harness({ manifestGate: gate.promise });
  const firstUpdates: CheckRunView[] = [];
  const secondUpdates: CheckRunView[] = [];

  const first = startInput(host, [], 'turn1', true, (view) => firstUpdates.push(view));
  const second = startInput(host, [], 'turn2', true, (view) => secondUpdates.push(view));
  await waitFor(() => store.get('codex', 'thread', 'turn1')?.status === 'skipped', 'first cancelled');
  gate.resolve(undefined);
  await Promise.all([first, second]);

  assert.equal(commands.length, 1);
  assert.equal(store.get('codex', 'thread', 'turn1')?.status, 'skipped');
  assert.equal(store.get('codex', 'thread', 'turn2')?.status, 'passed');
  assert.equal(firstUpdates.some((view) => view.status === 'passed'), false);
  assert.equal(secondUpdates.at(-1)?.status, 'passed');
});

test('the active slot is keyed by backend and thread, not thread alone', async () => {
  const { host, store, commands } = harness();
  await Promise.all([
    host.startTurnChecks({ backendId: 'codex', threadId: 'thread', turnId: 'a', hasChanges: true }),
    host.startTurnChecks({ backendId: 'zen', threadId: 'thread', turnId: 'b', hasChanges: true })
  ]);

  assert.equal(commands.length, 2);
  assert.equal(store.get('codex', 'thread', 'a')?.status, 'passed');
  assert.equal(store.get('zen', 'thread', 'b')?.status, 'passed');
});

test('the started guard is pruned when a run settles and the stored result blocks a rerun', async () => {
  const { host, store, updates, commands } = harness();
  await startInput(host, updates, 'turn');
  assert.equal(host.hasStarted('codex', 'thread', 'turn'), false);

  await startInput(host, updates, 'turn');
  assert.equal(commands.length, 1);
  assert.equal(store.get('codex', 'thread', 'turn')?.status, 'passed');
});

test('checks are spawned with stdin ignored so a stdin-reading check cannot hang', async () => {
  const text = await readFile(join(process.cwd(), 'src', 'review', 'vscodeCheckHost.ts'), 'utf8');
  assert.match(text, /stdio:\s*\[\s*'ignore'\s*,\s*'pipe'\s*,\s*'pipe'\s*\]/);
});

test('the host core stays free of vscode and process imports', async () => {
  for (const file of ['checkHost.ts', 'checkSettings.ts', 'checkStore.ts', 'checkGate.ts']) {
    const text = await readFile(join(process.cwd(), 'src', 'review', file), 'utf8');
    assert.equal(/\bfrom\s+['"]vscode["']/.test(text), false, file);
    assert.equal(/\bfrom\s+['"](node:)?(fs|child_process|net|http|https)["']/.test(text), false, file);
    assert.equal(/\bconsole\./.test(text), false, file);
    assert.equal(/\bfrom\s+['"][^'"]*approval/.test(text), false, file);
  }
});
