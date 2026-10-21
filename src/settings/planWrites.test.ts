import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeSettingsWrites,
  planSettingsWrites,
  type SettingsWrite
} from './planWrites.ts';
import type { SettingsPatch } from '../protocol.ts';
import { TRUST_SENSITIVE_FIELDS } from '../config/fieldNotices.ts';
import { effectiveSettingsTarget } from '../config/settingsScope.ts';
import { resolveWriteScope } from '../config/trust.ts';

/**
 * The complete patch the screen can send. Kept explicit so a field added to
 * `SettingsPatch` without a write fails here rather than becoming an inert
 * control.
 */
const ALL_FIELDS: Array<keyof SettingsPatch> = [
  'ollamaBaseUrl',
  'ollamaDefaultModel',
  'ollamaLocalBaseUrl',
  'ollamaLocalDefaultModel',
  'opencodeDefaultModel',
  'codexPath',
  'codexDefaultModel',
  'permissionLevel',
  'mode',
  'thinking',
  'dictationModel',
  'orchestrationTesting',
  'orchestrationReviewing',
  'orchestrationDoubleCheck',
  'orchestrationQuickTask',
  'orchestrationPlanning',
  'opencodeCliSource',
  'opencodePath',
  'browserCodex',
  'browserOpencode',
  'zvecGrepCliSource',
  'zvecGrepPath',
  'astGrepCliSource',
  'astGrepPath',
  'contextIncludeInstructions',
  'contextIncludeShape',
  'contextIncludeEditorState',
  'contextIncludeSelection',
  'contextIncludeChangedFiles',
  'contextMaxBytes',
  'contextExclude'
];

const PATCH: Required<SettingsPatch> = {
  ollamaBaseUrl: 'https://ollama.example',
  ollamaDefaultModel: 'qwen3-coder:480b',
  ollamaLocalBaseUrl: 'http://localhost:11434',
  ollamaLocalDefaultModel: 'qwen2.5-coder:7b',
  opencodeDefaultModel: 'big-pickle',
  codexPath: 'C:\\Tools\\codex.exe',
  codexDefaultModel: 'gpt-5-codex',
  permissionLevel: 'read-only',
  mode: 'plan',
  thinking: 'high',
  dictationModel: 'ollama|llama3.2:3b',
  orchestrationTesting: false,
  orchestrationReviewing: true,
  orchestrationDoubleCheck: false,
  orchestrationQuickTask: true,
  orchestrationPlanning: false,
  opencodeCliSource: 'local',
  opencodePath: 'C:\\Tools\\opencode.exe',
  browserCodex: false,
  browserOpencode: true,
  zvecGrepCliSource: 'local',
  zvecGrepPath: 'C:\\Tools\\zg.exe',
  astGrepCliSource: 'local',
  astGrepPath: 'C:\\Tools\\ast-grep.exe',
  contextIncludeInstructions: false,
  contextIncludeShape: true,
  contextIncludeEditorState: false,
  contextIncludeSelection: true,
  contextIncludeChangedFiles: false,
  contextMaxBytes: 32768,
  contextExclude: ['**/snapshots/**']
};

function byField(writes: SettingsWrite[]): Map<keyof SettingsPatch, SettingsWrite> {
  return new Map(writes.map((write) => [write.field, write]));
}

test('every patch field becomes exactly one write, including booleans and selects', () => {
  const plan = planSettingsWrites(PATCH, 'global');
  assert.deepEqual(plan.errors, {});
  assert.equal(plan.writes.length, ALL_FIELDS.length);

  const writes = byField(plan.writes);
  for (const field of ALL_FIELDS) {
    const write = writes.get(field);
    assert.ok(write, `${field} has no write`);
    assert.equal(write.field, field);
    assert.equal(write.scope, 'global');
  }

  assert.equal(writes.get('orchestrationReviewing')?.value, true);
  assert.equal(writes.get('mode')?.value, 'plan');
  assert.equal(writes.get('thinking')?.value, 'high');
  assert.equal(writes.get('contextMaxBytes')?.value, 32768);
  assert.equal(writes.get('browserOpencode')?.value, true);
});

test('a workspace save writes the effective scope and redirects trust-sensitive fields to user settings', () => {
  const plan = planSettingsWrites(PATCH, 'workspace');
  assert.deepEqual(plan.errors, {});
  const writes = byField(plan.writes);

  for (const field of ALL_FIELDS) {
    const write = writes.get(field);
    assert.ok(write, `${field} has no write`);
    const trusted = (TRUST_SENSITIVE_FIELDS as readonly string[]).includes(field);
    assert.equal(write.scope, trusted ? 'global' : 'workspace', field);
    assert.equal(plan.notices[field] !== undefined, trusted, field);
    if (trusted) {
      assert.match(plan.notices[field] ?? '', /user settings/i);
    }
  }
});

test('path fields are always written, even when the source is bundled', () => {
  const plan = planSettingsWrites(
    {
      opencodeCliSource: 'bundled',
      opencodePath: 'C:\\Tools\\opencode.exe',
      zvecGrepCliSource: 'bundled',
      zvecGrepPath: 'C:\\Tools\\zg.exe',
      astGrepCliSource: 'bundled',
      astGrepPath: 'C:\\Tools\\ast-grep.exe'
    },
    'global'
  );
  assert.deepEqual(plan.errors, {});
  const writes = byField(plan.writes);
  assert.equal(writes.get('opencodePath')?.value, 'C:\\Tools\\opencode.exe');
  assert.equal(writes.get('zvecGrepPath')?.value, 'C:\\Tools\\zg.exe');
  assert.equal(writes.get('astGrepPath')?.value, 'C:\\Tools\\ast-grep.exe');
  assert.equal(writes.get('opencodeCliSource')?.value, 'bundled');
  assert.equal(writes.get('zvecGrepCliSource')?.value, 'bundled');
  assert.equal(writes.get('astGrepCliSource')?.value, 'bundled');
});

test('an invalid field is refused and named, while the rest of the patch is planned', () => {
  const plan = planSettingsWrites(
    {
      ...PATCH,
      ollamaBaseUrl: 'not-a-url',
      contextMaxBytes: Number.NaN,
      astGrepPath: './workspace/ast-grep.exe'
    },
    'global'
  );
  const fields = byField(plan.writes);
  assert.equal(fields.has('ollamaBaseUrl'), false);
  assert.equal(fields.has('contextMaxBytes'), false);
  assert.equal(fields.has('astGrepPath'), false);
  assert.match(plan.errors.ollamaBaseUrl ?? '', /full URL/i);
  assert.match(plan.errors.contextMaxBytes ?? '', /whole number/i);
  assert.match(plan.errors.astGrepPath ?? '', /relative path/i);
  // A refused field does not drop the others.
  assert.equal(fields.get('ollamaDefaultModel')?.value, PATCH.ollamaDefaultModel);
  assert.equal(fields.get('zvecGrepPath')?.value, PATCH.zvecGrepPath);
});

test('execution names the failed write and still applies the writes after it', async () => {
  const plan = planSettingsWrites(PATCH, 'global');
  const written: SettingsWrite[] = [];
  const result = await executeSettingsWrites(plan, async (write) => {
    if (write.key === 'melink.context.maxBytes') {
      throw new Error('locked by policy');
    }
    written.push(write);
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.contextMaxBytes ?? '', /could not be written/i);
  assert.equal(written.some((write) => write.field === 'contextExclude'), true);
  assert.equal(written.length, plan.writes.length - 1);
  assert.equal(Object.keys(result.errors).length, 1);
});

test('a fully accepted plan reports success and keeps redirected-scope notices', async () => {
  const plan = planSettingsWrites(PATCH, 'workspace');
  const result = await executeSettingsWrites(plan, async () => {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.match(result.notices?.ollamaBaseUrl ?? '', /user settings/i);
});

test('a folder override controls the target and the save lands in the folder', () => {
  const inspected: Record<
    string,
    { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }
  > = {
    'melink.context.maxBytes': { globalValue: 20480, workspaceValue: 4096, workspaceFolderValue: 8192 },
    'melink.context.exclude': { globalValue: [] as string[], workspaceValue: ['**/out/**'] },
    'melink.orchestration.testing': { globalValue: true }
  };
  const entries = Object.entries(inspected).map(([key, value]) => ({ key, inspected: value }));
  const target = effectiveSettingsTarget(entries);
  assert.equal(target, 'folder');

  const plan = planSettingsWrites({ contextMaxBytes: 16384, contextExclude: ['**/dist/**'] }, target, {
    scopeFor: (key) => resolveWriteScope(target, inspected[key])
  });
  const writes = byField(plan.writes);
  // The folder value controls maxBytes, so the write must beat that override.
  assert.equal(writes.get('contextMaxBytes')?.scope, 'folder');
  // A workspace-only override keeps its own scope; the folder value would
  // otherwise shadow it.
  assert.equal(writes.get('contextExclude')?.scope, 'workspace');
});

test('after reload the folder value is still the controlling value', () => {
  const saved = {
    globalValue: 20480,
    workspaceValue: 4096,
    workspaceFolderValue: 16384
  };
  const entries = [{ key: 'melink.context.maxBytes', inspected: saved }];
  assert.equal(effectiveSettingsTarget(entries), 'folder');
  assert.equal(resolveWriteScope('folder', saved), 'folder');
  // The user save stays global so it cannot silently create another override.
  assert.equal(resolveWriteScope('global', saved), 'global');
});

test('a folder save still redirects trust-sensitive fields to user settings', () => {
  const plan = planSettingsWrites(PATCH, 'folder', {
    scopeFor: () => 'folder'
  });
  const writes = byField(plan.writes);
  assert.equal(writes.get('contextMaxBytes')?.scope, 'folder');
  assert.equal(writes.get('ollamaBaseUrl')?.scope, 'global');
  assert.match(plan.notices.ollamaBaseUrl ?? '', /user settings/i);
});
