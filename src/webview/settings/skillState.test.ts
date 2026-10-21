import test from 'node:test';
import assert from 'node:assert/strict';
import { chipClass, skillChecked, skillChip, skillStatusText } from './skillState.ts';

const base = {
  enabled: false,
  connected: false,
  cli: 'missing' as const,
  status: 'missing' as const
};

test('the reload checkbox follows the saved enabled flag, not the handshake', () => {
  assert.equal(
    skillChecked({ pending: false, snapshot: { enabled: true } }),
    true
  );
  assert.equal(
    skillChecked({ pending: true, requested: false, snapshot: { enabled: true } }),
    false
  );
});

test('chips name every state the panel must explain', () => {
  assert.deepEqual(skillChip({ skill: 'astGrep', pending: true, snapshot: { ...base, enabled: true } }), {
    label: 'Working...',
    tone: 'working'
  });
  assert.deepEqual(skillChip({ skill: 'astGrep', pending: false, snapshot: base }), {
    label: 'Missing binary',
    tone: 'missing'
  });
  assert.deepEqual(
    skillChip({
      skill: 'astGrep',
      pending: false,
      snapshot: { ...base, cli: 'installed', status: 'detected' }
    }),
    { label: 'Needs setup', tone: 'needs' }
  );
  assert.deepEqual(
    skillChip({
      skill: 'astGrep',
      pending: false,
      snapshot: { ...base, enabled: true, connected: true, cli: 'installed', status: 'detected' }
    }),
    { label: 'Ready', tone: 'ready' }
  );
  assert.deepEqual(
    skillChip({
      skill: 'zvecGrep',
      pending: false,
      snapshot: {
        ...base,
        enabled: true,
        connected: true,
        cli: 'installed',
        status: 'detected',
        index: 'missing'
      }
    }),
    { label: 'Index missing', tone: 'index' }
  );
  assert.deepEqual(
    skillChip({
      skill: 'astGrep',
      pending: false,
      snapshot: {
        ...base,
        enabled: true,
        cli: 'installed',
        status: 'detected',
        detail: 'The MCP shim did not answer.'
      }
    }),
    { label: 'Error', tone: 'error' }
  );
});

test('chip tones map to existing token classes', () => {
  assert.equal(chipClass('ready'), 'chip chip--stored');
  assert.equal(chipClass('index'), 'chip chip--warning');
  assert.equal(chipClass('error'), 'chip chip--missing');
});

test('status text names the next action', () => {
  assert.match(
    skillStatusText({ skill: 'astGrep', pending: false, snapshot: base }),
    /Install it/
  );
  assert.match(
    skillStatusText({
      skill: 'astGrep',
      pending: false,
      snapshot: { ...base, cli: 'installed', status: 'detected' }
    }),
    /Turn this on/
  );
  assert.match(
    skillStatusText({
      skill: 'astGrep',
      pending: false,
      snapshot: {
        ...base,
        enabled: true,
        cli: 'installed',
        status: 'detected',
        detail: 'The MCP shim did not answer.'
      }
    }),
    /MCP shim/
  );
  const indexMissing = skillStatusText({
    skill: 'zvecGrep',
    pending: false,
    snapshot: {
      ...base,
      enabled: true,
      connected: true,
      cli: 'installed',
      status: 'detected',
      index: 'missing'
    }
  });
  assert.match(indexMissing, /Needs a workspace index/);
  assert.doesNotMatch(indexMissing, /^Ready\./);
});
