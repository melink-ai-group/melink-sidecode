import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SAFE_MODE_SETTINGS,
  readSafeModeSettings,
  safeModeDecision,
  storedRuleUnlessAsk,
  type SafeModeConfigReader,
  type SafeModeSettings
} from './safeMode.ts';
import { findMatchingRule, ruleFor } from './approvals.ts';
import type { ApprovalRequest } from './types.ts';

function request(command: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command,
    origin: '/workspace',
    ...overrides
  };
}

function settings(overrides: Partial<SafeModeSettings> = {}): SafeModeSettings {
  return { ...DEFAULT_SAFE_MODE_SETTINGS, ...overrides };
}

test('a non-command request is always allowed', () => {
  assert.deepEqual(
    safeModeDecision(
      { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/workspace/a.ts'] },
      settings({ destructiveCommands: 'block' })
    ),
    { action: 'allow' }
  );
  assert.deepEqual(
    safeModeDecision({ id: 'r', kind: 'permissions', method: 'x', network: 'example.test' }, settings({ destructiveCommands: 'block' })),
    { action: 'allow' }
  );
  assert.deepEqual(safeModeDecision(request('git status')), { action: 'allow' });
});

test('the default action is ask and the default pattern list is empty', async () => {
  assert.equal(DEFAULT_SAFE_MODE_SETTINGS.destructiveCommands, 'ask');
  assert.deepEqual(DEFAULT_SAFE_MODE_SETTINGS.destructivePatterns, []);
  // No extension host in a plain Node test: the documented defaults apply.
  assert.deepEqual(readSafeModeSettings(), { destructiveCommands: 'ask', destructivePatterns: [] });
  const decision = safeModeDecision(request('git push --force'));
  assert.equal(decision.action, 'ask');
});

test('ask names the risk and the exact command and reports its category', () => {
  const approval = request('git push --force origin main');
  const decision = safeModeDecision(approval, settings());
  assert.equal(decision.action, 'ask');
  if (decision.action !== 'ask') {
    assert.fail('expected ask');
  }
  assert.equal(decision.category, 'force-push');
  assert.equal(decision.label, 'force push');
  assert.equal(decision.command, 'git push --force origin main');
  assert.match(decision.reason, /force push/i);
  assert.match(decision.reason, /git push --force origin main/);
  assert.equal(approval.reason, decision.reason);
});

test('block refuses the same recognised commands with a risk reason', () => {
  const decision = safeModeDecision(request('rm -rf /tmp/build'), settings({ destructiveCommands: 'block' }));
  assert.equal(decision.action, 'block');
  if (decision.action !== 'block') {
    assert.fail('expected block');
  }
  assert.equal(decision.category, 'recursive-delete');
  assert.match(decision.reason, /^Blocked recursive delete:/);
  assert.match(decision.reason, /rm -rf \/tmp\/build/);
});

test('ask and block reasons redact common command-line credentials', () => {
  const raw = 'mysql -uroot -psecret -e "DROP DATABASE app"';
  for (const destructiveCommands of ['ask', 'block'] as const) {
    const approval = request(raw);
    const decision = safeModeDecision(approval, settings({ destructiveCommands }));
    assert.notEqual(decision.action, 'allow');
    if (decision.action === 'allow') {
      assert.fail('expected a forced decision');
    }
    assert.equal(decision.reason.includes('secret'), false);
    assert.equal(decision.command.includes('secret'), false);
    assert.match(decision.reason, /<redacted>/);
    // The raw command stays intact for rule matching; only the display copy is
    // redacted.
    assert.equal(approval.command, raw);
    assert.equal(approval.displayCommand, decision.command);
    assert.equal(approval.displayCommand?.includes('secret'), false);
    assert.equal(approval.reason, decision.reason);
  }
});

test('off allows recognised destructive commands so stored rules decide again', () => {
  assert.deepEqual(safeModeDecision(request('git reset --hard'), settings({ destructiveCommands: 'off' })), {
    action: 'allow'
  });
  assert.deepEqual(safeModeDecision(request('psql -c "DROP TABLE users"'), settings({ destructiveCommands: 'off' })), {
    action: 'allow'
  });
});

test('custom patterns use the same ask/block action and invalid patterns do not crash', () => {
  const ask = safeModeDecision(request('kubectl delete namespace prod'), settings({ destructivePatterns: ['kubectl\\s+delete'] }));
  assert.equal(ask.action, 'ask');
  if (ask.action === 'ask') {
    assert.equal(ask.category, 'custom');
    assert.match(ask.reason, /custom destructive pattern/);
  } else {
    assert.fail('expected ask');
  }
  const block = safeModeDecision(
    request('terraform destroy'),
    settings({ destructiveCommands: 'block', destructivePatterns: ['terraform\\s+destroy'] })
  );
  assert.equal(block.action, 'block');
  assert.equal(safeModeDecision(request('terraform destroy'), settings({ destructivePatterns: ['('] })).action, 'allow');
});

test('a stored first-token git rule still matches, but the ask path returns no rule', () => {
  const destructive = request('git push --force origin main');
  // The rule is exactly the broad first-token shape a user can store.
  const rule = ruleFor(request('git status'), 'codex', 1);
  assert.deepEqual(rule.commandPrefix, ['git']);
  const wouldMatch = () => findMatchingRule(destructive, [], [rule]);
  assert.equal(wouldMatch()?.id, rule.id);

  const decision = safeModeDecision(destructive, settings());
  assert.equal(decision.action, 'ask');
  assert.equal(storedRuleUnlessAsk(decision, wouldMatch), undefined);
});

test('off lets the same stored rule answer again', () => {
  const destructive = request('git push --force origin main');
  const rule = ruleFor(request('git status'), 'codex', 1);
  const decision = safeModeDecision(destructive, settings({ destructiveCommands: 'off' }));
  assert.equal(decision.action, 'allow');
  assert.equal(storedRuleUnlessAsk(decision, () => findMatchingRule(destructive, [], [rule]))?.id, rule.id);
});

test('readSafeModeSettings degrades an unknown action and filters non-string patterns', () => {
  const reader: SafeModeConfigReader = {
    get<T>(key: string, defaultValue: T): T {
      if (key === 'destructiveCommands') {
        return 'destroy-everything' as T;
      }
      if (key === 'destructivePatterns') {
        return ['kubectl\\s+delete', 42, null, { pattern: 'x' }, 'terraform\\s+destroy'] as T;
      }
      return defaultValue;
    }
  };
  assert.deepEqual(readSafeModeSettings(reader), {
    destructiveCommands: 'ask',
    destructivePatterns: ['kubectl\\s+delete', 'terraform\\s+destroy']
  });
});

test('readSafeModeSettings keeps a valid action and coerces a non-array pattern list to empty', () => {
  const reader: SafeModeConfigReader = {
    get<T>(key: string, defaultValue: T): T {
      if (key === 'destructiveCommands') {
        return 'block' as T;
      }
      if (key === 'destructivePatterns') {
        return 'not-an-array' as T;
      }
      return defaultValue;
    }
  };
  assert.deepEqual(readSafeModeSettings(reader), { destructiveCommands: 'block', destructivePatterns: [] });
});
