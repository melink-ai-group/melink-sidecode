import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commandPrefix,
  describeApproval,
  findMatchingRule,
  ruleFor,
  ruleMatchesRequest,
  ruleScopeFor,
  sessionKey,
  tokenize
} from './approvals.ts';
import type { ApprovalRequest, ApprovalRule } from './types.ts';

function commandRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command: 'git status',
    origin: '/workspace',
    ...overrides
  };
}

test('a decision maps to the scope it really persists', () => {
  assert.equal(ruleScopeFor('allow-once'), 'none');
  assert.equal(ruleScopeFor('reject'), 'none');
  assert.equal(ruleScopeFor('allow-always'), 'global');
  assert.equal(ruleScopeFor('allow-session'), 'session');
});

test('an always rule records the native exec-policy amendment it was offered', () => {
  const request = commandRequest({ execPolicyAmendment: ['git', 'status'] });
  const rule = ruleFor(request, 'codex', 1000);
  assert.equal(rule.backendId, 'codex');
  assert.equal(rule.kind, 'command');
  assert.deepEqual(rule.execPolicyAmendment, ['git', 'status']);
  assert.deepEqual(rule.commandPrefix, ['git', 'status']);
  assert.equal(rule.origin, '/workspace');
  assert.equal(rule.createdAt, 1000);
});

test('a command rule without an amendment falls back to the first token only', () => {
  const rule = ruleFor(commandRequest({ command: 'git commit -m "x"' }), 'codex', 1);
  assert.deepEqual(rule.commandPrefix, ['git']);
  assert.equal(rule.execPolicyAmendment, undefined);
});

test('a stored command rule matches a command with the same prefix', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git status --short' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'git commit' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ command: 'npm test' })), false);
});

test('a command rule never matches a different kind of request', () => {
  const rule = ruleFor(commandRequest({ command: 'git status' }), 'codex', 1);
  const fileRequest: ApprovalRequest = {
    id: 'r2',
    kind: 'file-change',
    method: 'item/fileChange/requestApproval',
    paths: ['/workspace/file.ts']
  };
  assert.equal(ruleMatchesRequest(rule, fileRequest), false);
});

test('a file-change rule records the root it is scoped to', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/workspace/src'] },
    'codex',
    1
  );
  assert.deepEqual(rule.paths, ['/workspace/src']);
  assert.equal(rule.kind, 'file-change');
});

test('a grant-root file-change rule records that root as its scope', () => {
  const rule = ruleFor(
    {
      id: 'r',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      grantRoot: '/workspace/extra'
    },
    'codex',
    1
  );
  assert.deepEqual(rule.paths, ['/workspace/extra']);
});

test('a file rule matches only paths under its recorded root', () => {
  const rule = ruleFor(
    { id: 'r', kind: 'file-change', method: 'item/fileChange/requestApproval', paths: ['/workspace/src'] },
    'codex',
    1
  );
  assert.equal(
    ruleMatchesRequest(rule, {
      id: 'r3',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      paths: ['/workspace/src/index.ts']
    }),
    true
  );
  assert.equal(
    ruleMatchesRequest(rule, {
      id: 'r4',
      kind: 'file-change',
      method: 'item/fileChange/requestApproval',
      paths: ['/etc/passwd']
    }),
    false
  );
});

test('a permissions rule matches only the same network host', () => {
  const rule: ApprovalRule = {
    id: 'r',
    backendId: 'codex',
    kind: 'permissions',
    scope: 'network access to example.test',
    host: 'example.test',
    createdAt: 1
  };
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions', network: 'example.test' })), true);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions', network: 'other.test' })), false);
  assert.equal(ruleMatchesRequest(rule, commandRequest({ kind: 'permissions' })), false);
});

test('a session rule is preferred over a global rule for the same request', () => {
  const session = { ...ruleFor(commandRequest({ command: 'git status' }), 'codex', 1), id: 'session' };
  const global = { ...ruleFor(commandRequest({ command: 'git status' }), 'codex', 2), id: 'global' };
  const matched = findMatchingRule(commandRequest({ command: 'git status --short' }), [session], [global]);
  assert.equal(matched?.id, 'session');
});

test('a request no rule covers matches nothing, so the user must be asked', () => {
  const global: ApprovalRule[] = [ruleFor(commandRequest({ command: 'git status' }), 'codex', 1)];
  assert.equal(findMatchingRule(commandRequest({ command: 'rm -rf /' }), [], global), undefined);
});

test('the session key is per backend and per thread, so scopes cannot leak', () => {
  assert.equal(sessionKey('codex', 'thread-1'), 'codex:thread-1');
  assert.notEqual(sessionKey('codex', 'thread-1'), sessionKey('codex', 'thread-2'));
  assert.notEqual(sessionKey('codex', 'thread-1'), sessionKey('ollama', 'thread-1'));
});

test('describeApproval names the command or path scope it actually covers', () => {
  assert.equal(describeApproval(commandRequest({ command: 'ls' })), 'ls');
  assert.equal(describeApproval(commandRequest({ command: undefined })), 'a command');
  assert.equal(
    describeApproval(
      commandRequest({
        command: 'mysql -uroot -psecret -e "DROP DATABASE app"',
        displayCommand: 'mysql -uroot -p<redacted> -e "DROP DATABASE app"'
      })
    ),
    'mysql -uroot -p<redacted> -e "DROP DATABASE app"'
  );
  assert.equal(describeApproval({ id: 'r', kind: 'file-change', method: 'x', paths: ['/a'] }), 'writes under /a');
  assert.equal(
    describeApproval({ id: 'r', kind: 'file-change', method: 'x', paths: ['/a', '/b'] }),
    'writes under 2 paths'
  );
});

test('tokenize keeps quoted groups and commandPrefix takes the first token', () => {
  assert.deepEqual(tokenize('git commit -m "two words"'), ['git', 'commit', '-m', 'two words']);
  assert.deepEqual(commandPrefix('  git   status  '), ['git']);
  assert.deepEqual(commandPrefix(''), []);
});
