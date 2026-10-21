import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHECK_SECTION,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  MAX_CHECK_TIMEOUT_SECONDS,
  MIN_CHECK_TIMEOUT_SECONDS,
  clampCheckTimeoutSeconds,
  readCheckSettingsFrom,
  resolveCheckSettingsInput
} from './checkSettings.ts';

test('an absent commands value is auto-detect, while an explicit empty list disables checks', () => {
  const auto = readCheckSettingsFrom(
    {
      enabled: { globalValue: true },
      commands: { defaultValue: [] },
      timeoutSeconds: { defaultValue: 120 }
    },
    true
  );
  assert.equal(auto.commands, undefined);
  assert.equal(auto.enabled, true);
  assert.equal(auto.timeoutMs, 120_000);
  assert.equal(auto.trusted, true);

  const explicitEmpty = readCheckSettingsFrom(
    {
      enabled: { globalValue: true },
      commands: { defaultValue: [], globalValue: [] },
      timeoutSeconds: { defaultValue: 120 }
    },
    true
  );
  assert.deepEqual(explicitEmpty.commands, []);
});

test('a fresh profile is off and the schema default is not an explicit choice', () => {
  const fresh = readCheckSettingsFrom({}, true);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.commands, undefined);

  // The contributed default (now false) is still only a default: it neither
  // turns checks on by itself nor looks like a user override.
  const schemaDefaultOn = readCheckSettingsFrom({ enabled: { defaultValue: true } }, true);
  assert.equal(schemaDefaultOn.enabled, false);

  assert.equal(readCheckSettingsFrom({ enabled: { globalValue: true } }, true).enabled, true);
  assert.equal(readCheckSettingsFrom({ enabled: { globalValue: false } }, true).enabled, false);
  assert.equal(readCheckSettingsFrom({ enabled: { workspaceFolderValue: true } }, true).enabled, true);
});

test('workspace and folder values override global values, folder first', () => {
  const settings = readCheckSettingsFrom(
    {
      enabled: { globalValue: false, workspaceValue: true },
      commands: {
        globalValue: ['npm test'],
        workspaceValue: ['pnpm build'],
        workspaceFolderValue: ['bun run check']
      },
      timeoutSeconds: { globalValue: 30, workspaceValue: 45 }
    },
    true
  );
  assert.equal(settings.enabled, true);
  assert.deepEqual(settings.commands, ['bun run check']);
  assert.equal(settings.timeoutMs, 45_000);
});

test('the timeout is clamped to the documented range and invalid values fall back', () => {
  assert.equal(clampCheckTimeoutSeconds(1), MIN_CHECK_TIMEOUT_SECONDS);
  assert.equal(clampCheckTimeoutSeconds(999), MAX_CHECK_TIMEOUT_SECONDS);
  assert.equal(clampCheckTimeoutSeconds(30), 30);
  assert.equal(clampCheckTimeoutSeconds('30'), DEFAULT_CHECK_TIMEOUT_SECONDS);
  assert.equal(clampCheckTimeoutSeconds(Number.NaN), DEFAULT_CHECK_TIMEOUT_SECONDS);
  assert.equal(
    readCheckSettingsFrom({ timeoutSeconds: { globalValue: 600 } }, true).timeoutMs,
    600_000
  );
});

test('trust is carried through even when checks are configured', () => {
  const settings = readCheckSettingsFrom(
    {
      enabled: { globalValue: true },
      commands: { globalValue: ['npm test'] }
    },
    false
  );
  assert.equal(settings.trusted, false);
  assert.deepEqual(settings.commands, ['npm test']);
});

test('a package-default command list never turns auto-detection off, but a real default does', () => {
  const schemaDefault = resolveCheckSettingsInput({
    commandsDefault: [],
    trusted: true
  });
  assert.equal(schemaDefault.commands, undefined);

  const realDefault = resolveCheckSettingsInput({
    commandsDefault: ['npm run typecheck'],
    trusted: true
  });
  assert.deepEqual(realDefault.commands, ['npm run typecheck']);
});

test('malformed command values fall back to auto-detection instead of becoming a weird run', () => {
  const settings = resolveCheckSettingsInput({
    commandsGlobal: 'npm test',
    trusted: true
  });
  assert.equal(settings.commands, undefined);

  const mixed = resolveCheckSettingsInput({
    commandsGlobal: ['npm test', 3, null],
    trusted: true
  });
  assert.deepEqual(mixed.commands, ['npm test']);
});

test('package.json contributes the documented check settings and defaults', async () => {
  const manifest = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8')
  ) as {
    contributes: {
      configuration: {
        properties: Record<
          string,
          { type?: string; default?: unknown; minimum?: number; maximum?: number }
        >;
      };
    };
  };
  const properties = manifest.contributes.configuration.properties;
  const enabled = properties[`${CHECK_SECTION}.enabled`];
  const commands = properties[`${CHECK_SECTION}.commands`];
  const timeout = properties[`${CHECK_SECTION}.timeoutSeconds`];

  assert.equal(enabled?.type, 'boolean');
  assert.equal(enabled?.default, false);
  assert.equal(commands?.type, 'array');
  assert.deepEqual(commands?.default, []);
  assert.equal(timeout?.type, 'number');
  assert.equal(timeout?.default, DEFAULT_CHECK_TIMEOUT_SECONDS);
  assert.equal(timeout?.minimum, MIN_CHECK_TIMEOUT_SECONDS);
  assert.equal(timeout?.maximum, MAX_CHECK_TIMEOUT_SECONDS);
});
