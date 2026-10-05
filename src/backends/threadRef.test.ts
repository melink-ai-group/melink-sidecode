import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeThreadRef } from './threadRef.ts';

interface SampleRef {
  backendId: string;
  threadId: string;
  title: string;
  mode?: 'agent';
  opencodeSessionId?: string;
  handoverSummary?: string;
}

test('refreshing a thread keeps the opencode session and a codex thread id', () => {
  const previous: SampleRef = {
    backendId: 'ollama',
    threadId: 'thread_1',
    title: 'Hello',
    opencodeSessionId: 'ses_1'
  };
  const refreshed = mergeThreadRef(previous, {
    backendId: 'ollama',
    threadId: 'thread_1',
    title: 'Hello again',
    mode: 'agent'
  });
  assert.equal(refreshed.opencodeSessionId, 'ses_1');
  assert.equal(refreshed.title, 'Hello again');
  assert.equal(refreshed.threadId, 'thread_1');

  const omitted = mergeThreadRef(refreshed, { ...refreshed, opencodeSessionId: undefined });
  assert.equal(omitted.opencodeSessionId, 'ses_1');

  const codex = mergeThreadRef<SampleRef>(
    { backendId: 'codex', threadId: 'thr_codex', title: 'Old' },
    { backendId: 'codex', threadId: 'thr_codex', title: 'New' }
  );
  assert.equal(codex.threadId, 'thr_codex');
  assert.equal(codex.opencodeSessionId, undefined);
});

test('refreshing a thread keeps the compaction handover', () => {
  const previous: SampleRef = {
    backendId: 'codex',
    threadId: 'thr_codex',
    title: 'Hello',
    handoverSummary: 'Keep the plan.'
  };
  const refreshed = mergeThreadRef(previous, {
    backendId: 'codex',
    threadId: 'thr_codex',
    title: 'Hello again'
  });
  assert.equal(refreshed.handoverSummary, 'Keep the plan.');
  assert.equal(refreshed.title, 'Hello again');
});
