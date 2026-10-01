import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalStore } from './approvalStore.ts';
import { ruleFor } from './approvals.ts';
import type { ApprovalRequest, ApprovalRule } from './types.ts';

/**
 * A minimal in-memory stand-in for `vscode.Memento`, so the store's rule-set
 * behaviour (what the rules surface reads) can be tested without the host.
 */
function memento(): import('vscode').Memento {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T): T => (data.has(key) ? (data.get(key) as T) : (fallback as T)),
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        data.delete(key);
      } else {
        data.set(key, value);
      }
    },
    keys: () => [...data.keys()]
  } as import('vscode').Memento;
}

function context(): import('vscode').ExtensionContext {
  return { globalState: memento(), workspaceState: memento() } as unknown as import('vscode').ExtensionContext;
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req_1',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    command: 'npm run build',
    origin: '/workspace',
    ...overrides
  };
}

test('an always decision stores a rule the rules surface can list and revoke', async () => {
  const store = new ApprovalStore(context());
  const rule = ruleFor(request(), 'codex', 1000);

  await store.addRule(rule, 'global');

  const listed = store.listGlobalRules();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, rule.id);
  assert.equal(listed[0].scope, 'npm run build');
  // The revocation route reads through `listRules` for the selected backend.
  assert.deepEqual(
    store.listRules('codex').map((entry) => entry.id),
    [rule.id]
  );

  await store.revokeRule(rule.id);
  assert.equal(store.listGlobalRules().length, 0);
  assert.equal(store.listRules('codex').length, 0);
});

test('a stored rule is visible to the read model as soon as the decision is made', () => {
  // `addRule` updates the in-memory set synchronously, so a listener reacting to
  // `approval/decided` (the host pushing a fresh snapshot) already sees the rule.
  const store = new ApprovalStore(context());
  const rule = ruleFor(request(), 'codex', 1000);
  void store.addRule(rule, 'global');

  assert.equal(store.listGlobalRules()[0]?.id, rule.id);
});

test('a session decision is scoped to its thread and never listed as global', async () => {
  const store = new ApprovalStore(context());
  const session: ApprovalRule = { ...ruleFor(request(), 'codex', 1000), id: 'session_rule' };

  await store.addRule(session, 'session', 'thread_1');

  assert.equal(store.listGlobalRules().length, 0);
  assert.deepEqual(
    store.listSessionRules('codex', 'thread_1').map((entry) => entry.id),
    ['session_rule']
  );
  // A different thread must not see it, so a session allow cannot leak.
  assert.equal(store.listSessionRules('codex', 'thread_2').length, 0);
});

test('rules for another backend are never listed against the selected one', async () => {
  const store = new ApprovalStore(context());
  await store.addRule(ruleFor(request(), 'ollama', 1000), 'global');
  assert.equal(store.listRules('codex').length, 0);
  assert.equal(store.listRules('ollama').length, 1);
});
