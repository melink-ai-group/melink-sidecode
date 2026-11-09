import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATION_DEFAULTS,
  ORCHESTRATION_KEYS,
  normalizeOrchestrationChoice,
  resolveOrchestrationSettings
} from './settings.ts';

test('defaults are the documented tri-state policy', () => {
  assert.deepEqual(resolveOrchestrationSettings({}), {
    testing: 'on',
    reviewing: 'auto',
    styling: 'auto',
    doubleCheck: 'auto',
    quickTask: 'off',
    planning: 'auto',
    dictation: true,
    legacyTesting: false,
    legacyReviewing: false
  });
  assert.deepEqual(ORCHESTRATION_DEFAULTS, {
    testing: 'on',
    reviewing: 'auto',
    styling: 'auto',
    doubleCheck: 'auto',
    quickTask: 'off',
    planning: 'auto'
  });
});

test('saved booleans migrate to On/Off on every key', () => {
  assert.equal(normalizeOrchestrationChoice(true), 'on');
  assert.equal(normalizeOrchestrationChoice(false), 'off');
  const settings = resolveOrchestrationSettings({
    testing: { globalValue: false },
    reviewing: { globalValue: true },
    styling: { workspaceValue: true },
    doubleCheck: { workspaceFolderValue: false },
    quickTask: { globalValue: true },
    planning: { globalValue: false }
  });
  assert.equal(settings.testing, 'off');
  assert.equal(settings.reviewing, 'on');
  assert.equal(settings.styling, 'on');
  assert.equal(settings.doubleCheck, 'off');
  assert.equal(settings.quickTask, 'on');
  assert.equal(settings.planning, 'off');
});

test('choice strings are accepted verbatim and case-normalised', () => {
  assert.equal(normalizeOrchestrationChoice(' AUTO '), 'auto');
  assert.equal(normalizeOrchestrationChoice('On'), 'on');
  assert.equal(normalizeOrchestrationChoice('off'), 'off');
  assert.equal(normalizeOrchestrationChoice('yes'), undefined);
  assert.equal(normalizeOrchestrationChoice(1), undefined);
  assert.equal(normalizeOrchestrationChoice(null), undefined);
});

test('an explicit new value wins over a legacy fallback in either direction', () => {
  const settings = resolveOrchestrationSettings({
    testing: { globalValue: 'off' },
    reviewing: { globalValue: 'on' },
    legacyTesting: { globalValue: true },
    legacyReviewing: { globalValue: false }
  });
  assert.equal(settings.testing, 'off');
  assert.equal(settings.reviewing, 'on');
  assert.equal(settings.legacyTesting, false);
  assert.equal(settings.legacyReviewing, false);
});

test('unset new keys fall back to the legacy review keys and flag the source', () => {
  const legacy = resolveOrchestrationSettings({
    legacyTesting: { globalValue: false },
    legacyReviewing: { globalValue: true }
  });
  assert.equal(legacy.testing, 'off');
  assert.equal(legacy.legacyTesting, true);
  assert.equal(legacy.reviewing, 'on');
  assert.equal(legacy.legacyReviewing, true);

  const legacyDefaults = resolveOrchestrationSettings({
    legacyTesting: { defaultValue: false },
    legacyReviewing: { defaultValue: true }
  });
  assert.equal(legacyDefaults.testing, 'on');
  assert.equal(legacyDefaults.legacyTesting, false);
  assert.equal(legacyDefaults.reviewing, 'auto');
  assert.equal(legacyDefaults.legacyReviewing, false);
});

test('folder beats workspace beats global, for new and legacy keys', () => {
  const settings = resolveOrchestrationSettings({
    testing: {
      globalValue: 'on',
      workspaceValue: 'auto',
      workspaceFolderValue: 'off'
    },
    reviewing: {
      globalValue: 'off',
      workspaceValue: 'on'
    },
    legacyTesting: {
      globalValue: true,
      workspaceValue: true,
      workspaceFolderValue: false
    }
  });
  assert.equal(settings.testing, 'off');
  assert.equal(settings.reviewing, 'on');
  assert.equal(settings.legacyTesting, false);

  const legacyOnly = resolveOrchestrationSettings({
    legacyTesting: {
      globalValue: true,
      workspaceValue: true,
      workspaceFolderValue: false
    }
  });
  assert.equal(legacyOnly.testing, 'off');
  assert.equal(legacyOnly.legacyTesting, true);
});

test('a defaultValue is not an explicit user value', () => {
  const settings = resolveOrchestrationSettings({
    testing: { defaultValue: 'off' },
    reviewing: { defaultValue: 'on' },
    doubleCheck: { defaultValue: 'off' },
    quickTask: { defaultValue: 'on' },
    planning: { defaultValue: 'off' },
    legacyTesting: { defaultValue: true },
    legacyReviewing: { defaultValue: false }
  });
  assert.equal(settings.testing, ORCHESTRATION_DEFAULTS.testing);
  assert.equal(settings.testing, 'on');
  assert.equal(settings.legacyTesting, false);
  assert.equal(settings.reviewing, ORCHESTRATION_DEFAULTS.reviewing);
  assert.equal(settings.doubleCheck, 'auto');
  assert.equal(settings.quickTask, 'off');
  assert.equal(settings.planning, 'auto');
});

test('each standalone key can be set to any of the three choices', () => {
  const settings = resolveOrchestrationSettings({
    styling: { globalValue: 'on' },
    doubleCheck: { globalValue: 'off' },
    quickTask: { globalValue: 'auto' },
    planning: { globalValue: 'on' }
  });
  assert.equal(settings.styling, 'on');
  assert.equal(settings.doubleCheck, 'off');
  assert.equal(settings.quickTask, 'auto');
  assert.equal(settings.planning, 'on');
});

test('malformed values are ignored rather than coerced', () => {
  const settings = resolveOrchestrationSettings({
    testing: { globalValue: 'yes' },
    reviewing: { workspaceValue: 1 },
    doubleCheck: { workspaceFolderValue: null },
    quickTask: { globalValue: 'true' },
    planning: { globalValue: {} }
  });
  assert.equal(settings.testing, 'on');
  assert.equal(settings.reviewing, 'auto');
  assert.equal(settings.styling, 'auto');
  assert.equal(settings.doubleCheck, 'auto');
  assert.equal(settings.quickTask, 'off');
  assert.equal(settings.planning, 'auto');
});

test('the dictation switch is a nearest-scope boolean that defaults to On', () => {
  assert.equal(resolveOrchestrationSettings({}).dictation, true);
  assert.equal(resolveOrchestrationSettings({ dictation: { globalValue: false } }).dictation, false);
  assert.equal(
    resolveOrchestrationSettings({
      dictation: { globalValue: false, workspaceValue: true, workspaceFolderValue: false }
    }).dictation,
    false
  );
  assert.equal(
    resolveOrchestrationSettings({
      dictation: { globalValue: true, workspaceValue: false }
    }).dictation,
    false
  );
  // A schema default is not an explicit user value, and a malformed value is
  // ignored rather than coerced into Off.
  assert.equal(resolveOrchestrationSettings({ dictation: { defaultValue: false } }).dictation, true);
  assert.equal(resolveOrchestrationSettings({ dictation: { globalValue: 'false' } }).dictation, true);
});

test('the exported key list is the six policy choices', () => {
  assert.deepEqual(ORCHESTRATION_KEYS, [
    'testing',
    'reviewing',
    'styling',
    'doubleCheck',
    'quickTask',
    'planning'
  ]);
});
