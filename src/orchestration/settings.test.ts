import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATION_DEFAULTS,
  ORCHESTRATION_KEYS,
  resolveOrchestrationSettings
} from './settings.ts';

test('defaults match the documented policy when nothing is set', () => {
  const settings = resolveOrchestrationSettings({});
  assert.deepEqual(settings, {
    testing: false,
    reviewing: false,
    styling: false,
    doubleCheck: true,
    quickTask: true,
    planning: true,
    legacyTesting: false,
    legacyReviewing: false
  });
});

test('an explicit new value wins over a legacy fallback in either direction', () => {
  const settings = resolveOrchestrationSettings({
    testing: { globalValue: false },
    reviewing: { globalValue: true },
    legacyTesting: { globalValue: true },
    legacyReviewing: { globalValue: false }
  });
  assert.equal(settings.testing, false);
  assert.equal(settings.reviewing, true);
  assert.equal(settings.legacyTesting, false);
  assert.equal(settings.legacyReviewing, false);
});

test('unset new keys fall back to the legacy review keys and flag the source', () => {
  const legacyOff = resolveOrchestrationSettings({
    legacyTesting: { globalValue: false },
    legacyReviewing: { globalValue: true }
  });
  assert.equal(legacyOff.testing, false);
  assert.equal(legacyOff.legacyTesting, true);
  assert.equal(legacyOff.reviewing, true);
  assert.equal(legacyOff.legacyReviewing, true);

  const legacyDefaults = resolveOrchestrationSettings({
    legacyTesting: { defaultValue: false },
    legacyReviewing: { defaultValue: true }
  });
  assert.equal(legacyDefaults.testing, false);
  assert.equal(legacyDefaults.legacyTesting, false);
  assert.equal(legacyDefaults.reviewing, false);
  assert.equal(legacyDefaults.legacyReviewing, false);
});

test('folder beats workspace beats global, for new and legacy keys', () => {
  const settings = resolveOrchestrationSettings({
    testing: {
      globalValue: true,
      workspaceValue: true,
      workspaceFolderValue: false
    },
    reviewing: {
      globalValue: false,
      workspaceValue: true
    },
    legacyTesting: {
      globalValue: true,
      workspaceValue: true,
      workspaceFolderValue: false
    }
  });
  assert.equal(settings.testing, false);
  assert.equal(settings.reviewing, true);
  assert.equal(settings.legacyTesting, false);

  const legacyOnly = resolveOrchestrationSettings({
    legacyTesting: {
      globalValue: true,
      workspaceValue: true,
      workspaceFolderValue: false
    }
  });
  assert.equal(legacyOnly.testing, false);
  assert.equal(legacyOnly.legacyTesting, true);
});

test('a defaultValue is not an explicit user value', () => {
  const settings = resolveOrchestrationSettings({
    testing: { defaultValue: false },
    reviewing: { defaultValue: true },
    doubleCheck: { defaultValue: false },
    quickTask: { defaultValue: false },
    planning: { defaultValue: false },
    // A fresh profile also carries the legacy schema default; it must not
    // look like a user chose testing on.
    legacyTesting: { defaultValue: true },
    legacyReviewing: { defaultValue: false }
  });
  assert.equal(settings.testing, ORCHESTRATION_DEFAULTS.testing);
  assert.equal(settings.testing, false);
  assert.equal(settings.legacyTesting, false);
  assert.equal(settings.reviewing, ORCHESTRATION_DEFAULTS.reviewing);
  assert.equal(settings.doubleCheck, true);
  assert.equal(settings.quickTask, true);
  assert.equal(settings.planning, true);
});

test('the effective testing value: new wins, legacy is only a fallback', () => {
  // New true beats an explicit legacy false (the takeover case).
  assert.equal(
    resolveOrchestrationSettings({
      testing: { globalValue: true },
      legacyTesting: { globalValue: false }
    }).testing,
    true
  );
  // New false beats an explicit legacy true.
  assert.equal(
    resolveOrchestrationSettings({
      testing: { globalValue: false },
      legacyTesting: { globalValue: true }
    }).testing,
    false
  );
  // New unset + legacy unset: the documented default (off) runs.
  assert.equal(
    resolveOrchestrationSettings({ legacyTesting: { globalValue: true } }).testing,
    true
  );
  assert.equal(resolveOrchestrationSettings({}).testing, false);
});

test('each of the three standalone toggles can be turned off explicitly', () => {
  const settings = resolveOrchestrationSettings({
    doubleCheck: { globalValue: false },
    quickTask: { globalValue: false },
    planning: { globalValue: false }
  });
  assert.equal(settings.doubleCheck, false);
  assert.equal(settings.quickTask, false);
  assert.equal(settings.planning, false);
  assert.equal(settings.testing, false);
  assert.equal(settings.reviewing, false);
  assert.equal(settings.styling, false);
});

test('malformed values are ignored rather than coerced', () => {
  const settings = resolveOrchestrationSettings({
    testing: { globalValue: 'yes' },
    reviewing: { workspaceValue: 1 },
    doubleCheck: { workspaceFolderValue: null },
    quickTask: { globalValue: 'true' },
    planning: { globalValue: {} }
  });
  assert.equal(settings.testing, false);
  assert.equal(settings.reviewing, false);
  assert.equal(settings.styling, false);
  assert.equal(settings.doubleCheck, true);
  assert.equal(settings.quickTask, true);
  assert.equal(settings.planning, true);
});

test('the exported key list is the six policy toggles', () => {
  assert.deepEqual(ORCHESTRATION_KEYS, [
    'testing',
    'reviewing',
    'styling',
    'doubleCheck',
    'quickTask',
    'planning'
  ]);
});
