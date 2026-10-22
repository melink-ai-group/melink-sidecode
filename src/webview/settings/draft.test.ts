import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedQuickTask } from './draft.ts';

const allPassesOff = { testing: false, reviewing: false, styling: false, doubleCheck: false, quickTask: true };

test('a stored quickTask=true opens clean when every pass is off', () => {
  assert.equal(normalizedQuickTask(allPassesOff), false);
});

test('quickTask stays true only when it is on and a pass can use it', () => {
  assert.equal(normalizedQuickTask({ ...allPassesOff, testing: true }), true);
  assert.equal(normalizedQuickTask({ ...allPassesOff, quickTask: false, reviewing: true }), false);
});

import { draftFrom, dirtyKeys, patchFrom, type Draft } from './draft.ts';
import type { SettingsPatch, SettingsSnapshot } from '../../protocol.ts';

function snapshot(): SettingsSnapshot {
  const bundled = { path: 'C:\\storage\\opencode\\opencode.exe', status: 'missing' as const };
  return {
    target: 'global',
    ollama: {
      baseUrl: 'https://ollama.com',
      defaultModel: 'qwen3-coder:480b',
      hasToken: true,
      status: 'available'
    },
    ollamaLocal: {
      baseUrl: 'http://localhost:11434',
      defaultModel: 'qwen2.5-coder:7b',
      status: 'available'
    },
    opencodeZen: { defaultModel: 'big-pickle', hasToken: false, status: 'available' },
    codex: { path: 'codex', defaultModel: 'gpt-5-codex', status: 'available' },
    opencode: {
      cliSource: 'local',
      path: 'opencode',
      status: 'detected',
      local: { path: 'opencode', status: 'detected', version: '1.1.65' },
      bundled,
      zvecGrep: { enabled: false, cli: 'missing' }
    },
    defaults: { permissionLevel: 'default', mode: 'agent', thinking: 'medium', dictationModel: '' },
    context: {
      includeInstructions: true,
      includeShape: true,
      includeEditorState: true,
      includeSelection: true,
      includeChangedFiles: true,
      maxBytes: 20480,
      defaultMaxBytes: 20480,
      minMaxBytes: 1024,
      maxMaxBytes: 204800,
      exclude: []
    },
    orchestration: {
      testing: false,
      reviewing: false,
      styling: false,
      doubleCheck: true,
      quickTask: true,
      planning: true,
      legacyTesting: false,
      legacyReviewing: false
    },
    skills: {
      browserCodex: true,
      browserOpencode: true,
      zvecGrep: {
        enabled: false,
        cliSource: 'local',
        path: 'zg',
        status: 'missing',
        local: { path: 'zg', status: 'missing' },
        bundled,
        connected: false,
        cli: 'missing'
      },
      astGrep: {
        enabled: false,
        cliSource: 'local',
        path: 'ast-grep',
        status: 'missing',
        local: { path: 'ast-grep', status: 'missing' },
        bundled,
        connected: false,
        cli: 'missing'
      }
    },
    models: {}
  };
}

/** The echo the host would send after applying the patch. */
function applied(settings: SettingsSnapshot, patch: SettingsPatch): SettingsSnapshot {
  return {
    ...settings,
    ollama: {
      ...settings.ollama,
      baseUrl: patch.ollamaBaseUrl ?? settings.ollama.baseUrl,
      defaultModel: patch.ollamaDefaultModel ?? settings.ollama.defaultModel
    },
    ollamaLocal: {
      ...settings.ollamaLocal,
      baseUrl: patch.ollamaLocalBaseUrl ?? settings.ollamaLocal.baseUrl,
      defaultModel: patch.ollamaLocalDefaultModel ?? settings.ollamaLocal.defaultModel
    },
    opencodeZen: {
      ...settings.opencodeZen,
      defaultModel: patch.opencodeDefaultModel ?? settings.opencodeZen.defaultModel
    },
    codex: {
      ...settings.codex,
      path: patch.codexPath ?? settings.codex.path,
      defaultModel: patch.codexDefaultModel ?? settings.codex.defaultModel
    },
    opencode: {
      ...settings.opencode,
      cliSource: patch.opencodeCliSource ?? settings.opencode.cliSource,
      path: patch.opencodePath ?? settings.opencode.path,
      local: {
        ...settings.opencode.local,
        path: patch.opencodePath ?? settings.opencode.local.path
      }
    },
    defaults: {
      ...settings.defaults,
      permissionLevel: patch.permissionLevel ?? settings.defaults.permissionLevel,
      mode: patch.mode ?? settings.defaults.mode,
      thinking: (patch.thinking ?? settings.defaults.thinking) || undefined,
      dictationModel: patch.dictationModel ?? settings.defaults.dictationModel
    },
    orchestration: {
      ...settings.orchestration,
      testing: patch.orchestrationTesting ?? settings.orchestration.testing,
      reviewing: patch.orchestrationReviewing ?? settings.orchestration.reviewing,
      styling: patch.orchestrationStyling ?? settings.orchestration.styling,
      doubleCheck: patch.orchestrationDoubleCheck ?? settings.orchestration.doubleCheck,
      quickTask: patch.orchestrationQuickTask ?? settings.orchestration.quickTask,
      planning: patch.orchestrationPlanning ?? settings.orchestration.planning
    },
    skills: {
      ...settings.skills,
      browserCodex: patch.browserCodex ?? settings.skills.browserCodex,
      browserOpencode: patch.browserOpencode ?? settings.skills.browserOpencode,
      zvecGrep: {
        ...settings.skills.zvecGrep,
        cliSource: patch.zvecGrepCliSource ?? settings.skills.zvecGrep.cliSource,
        path: patch.zvecGrepPath ?? settings.skills.zvecGrep.path,
        local: {
          ...settings.skills.zvecGrep.local,
          path: patch.zvecGrepPath ?? settings.skills.zvecGrep.local.path
        }
      },
      astGrep: {
        ...settings.skills.astGrep,
        cliSource: patch.astGrepCliSource ?? settings.skills.astGrep.cliSource,
        path: patch.astGrepPath ?? settings.skills.astGrep.path,
        local: {
          ...settings.skills.astGrep.local,
          path: patch.astGrepPath ?? settings.skills.astGrep.local.path
        }
      }
    },
    context: {
      ...settings.context,
      includeInstructions: patch.contextIncludeInstructions ?? settings.context.includeInstructions,
      includeShape: patch.contextIncludeShape ?? settings.context.includeShape,
      includeEditorState: patch.contextIncludeEditorState ?? settings.context.includeEditorState,
      includeSelection: patch.contextIncludeSelection ?? settings.context.includeSelection,
      includeChangedFiles: patch.contextIncludeChangedFiles ?? settings.context.includeChangedFiles,
      maxBytes: patch.contextMaxBytes ?? settings.context.maxBytes,
      exclude: patch.contextExclude ?? settings.context.exclude
    }
  };
}

function changedDraft(): Draft {
  const draft = draftFrom(snapshot());
  draft.ollamaDefaultModel = 'kimi-k2:instruct';
  draft.permissionLevel = 'read-only';
  draft.mode = 'plan';
  draft.thinking = 'high';
  draft.dictationModel = 'ollama|qwen2.5-coder:7b';
  draft.orchestrationTesting = true;
  draft.orchestrationReviewing = true;
  draft.orchestrationDoubleCheck = false;
  draft.orchestrationQuickTask = false;
  draft.orchestrationPlanning = false;
  draft.browserCodex = false;
  draft.browserOpencode = false;
  draft.contextIncludeInstructions = false;
  draft.contextIncludeShape = false;
  draft.contextIncludeEditorState = false;
  draft.contextIncludeSelection = false;
  draft.contextIncludeChangedFiles = false;
  draft.contextMaxKb = '32';
  draft.contextExclude = ['**/snapshots/**'];
  draft.zvecGrepCliSource = 'bundled';
  draft.zvecGrepPath = 'C:\\Tools\\zg.exe';
  draft.astGrepCliSource = 'bundled';
  draft.astGrepPath = 'C:\\Tools\\ast-grep.exe';
  return draft;
}

test('every changed toggle, select and input is in the patch and in dirty keys', () => {
  const draft = changedDraft();
  const patch = patchFrom(draft);
  for (const field of [
    'ollamaDefaultModel',
    'permissionLevel',
    'mode',
    'thinking',
    'dictationModel',
    'orchestrationTesting',
    'orchestrationReviewing',
    'orchestrationDoubleCheck',
    'orchestrationQuickTask',
    'orchestrationPlanning',
    'browserCodex',
    'browserOpencode',
    'contextIncludeInstructions',
    'contextIncludeShape',
    'contextIncludeEditorState',
    'contextIncludeSelection',
    'contextIncludeChangedFiles',
    'contextMaxBytes',
    'contextExclude',
    'zvecGrepCliSource',
    'zvecGrepPath',
    'astGrepCliSource',
    'astGrepPath'
  ] as Array<keyof SettingsPatch>) {
    assert.ok(field in patch, `${field} missing from the patch`);
  }
  const dirty = dirtyKeys(draft, snapshot());
  for (const field of [
    'orchestrationTesting',
    'orchestrationReviewing',
    'orchestrationDoubleCheck',
    'orchestrationQuickTask',
    'orchestrationPlanning',
    'browserCodex',
    'browserOpencode',
    'contextIncludeShape',
    'contextMaxBytes',
    'zvecGrepCliSource',
    'astGrepPath'
  ] as Array<keyof SettingsPatch>) {
    assert.ok(dirty.includes(field), `${field} is not dirty`);
  }
});

test('the echo clears dirty state, and reopening seeds the saved values', () => {
  const original = snapshot();
  const draft = changedDraft();
  const patch = patchFrom(draft);
  const echoed = applied(original, patch);
  assert.deepEqual(dirtyKeys(draft, echoed), []);

  const reopened = draftFrom(echoed);
  assert.equal(reopened.ollamaDefaultModel, 'kimi-k2:instruct');
  assert.equal(reopened.orchestrationReviewing, true);
  assert.equal(reopened.contextMaxKb, '32');
  assert.deepEqual(reopened.contextExclude, ['**/snapshots/**']);
  assert.deepEqual(dirtyKeys(reopened, echoed), []);
});

test('a typed path persists while the source is bundled, so the save converges', () => {
  const original = snapshot();
  const draft = draftFrom(original);
  draft.zvecGrepPath = 'C:\\Tools\\zg.exe';
  draft.zvecGrepCliSource = 'bundled';
  draft.astGrepPath = 'C:\\Tools\\ast-grep.exe';
  draft.astGrepCliSource = 'bundled';

  const patch = patchFrom(draft);
  assert.equal(patch.zvecGrepPath, 'C:\\Tools\\zg.exe');
  assert.equal(patch.astGrepPath, 'C:\\Tools\\ast-grep.exe');
  assert.ok(dirtyKeys(draft, original).includes('zvecGrepPath'));

  const echoed = applied(original, patch);
  assert.equal(echoed.skills.zvecGrep.local.path, 'C:\\Tools\\zg.exe');
  assert.deepEqual(dirtyKeys(draft, echoed), []);
});

test('whitespace-only edits are not dirty because the patch trims them', () => {
  const original = snapshot();
  const draft = draftFrom(original);
  draft.ollamaBaseUrl = ` ${draft.ollamaBaseUrl} `;
  draft.codexPath = ` ${draft.codexPath} `;
  assert.deepEqual(dirtyKeys(draft, original), []);
});
