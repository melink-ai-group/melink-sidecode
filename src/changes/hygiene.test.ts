import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Static guards for the per-turn change journal. These read the source rather
 * than run it, so the storage-separation and read-only invariants hold for
 * every code path.
 */

async function source(relative: string): Promise<string> {
  return readFile(join(process.cwd(), 'src', ...relative.split('/')), 'utf8');
}

test('the journal core is host-free, so it is unit-testable headless', async () => {
  const text = await source('changes/journal.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
  assert.equal(/\bconsole\./.test(text), false);
});

test('the journal never writes a workspace file: only blobs and the index', async () => {
  const core = await source('changes/journal.ts');
  // The core has no write to a workspace path; its only storage writes are the
  // injected blob seam and the injected index seam.
  assert.match(core, /this\.fs\.writeBlob/);
  assert.match(core, /this\.storage\.update\(JOURNAL_KEY/);
  assert.equal(/\bwriteFile\s*\(/.test(core), false);
});

test('blob content is bound to storageUri and all file I/O to workspace.fs', async () => {
  const adapter = await source('changes/vscodeJournal.ts');
  assert.match(adapter, /this\.context\.storageUri/);
  assert.match(adapter, /vscode\.workspace\.fs\.readFile/);
  assert.match(adapter, /vscode\.workspace\.fs\.writeFile/);
  assert.match(adapter, /vscode\.workspace\.fs\.delete/);
  // No direct filesystem module is ever imported, so remote/virtual workspaces
  // work and the journal never bypasses the host.
  assert.equal(/from\s+['"]node:fs['"]/.test(adapter), false);
  assert.equal(/from\s+['"]fs['"]/.test(adapter), false);
});

test('the index key is melink.changeJournal in workspaceState, never globalState', async () => {
  const core = await source('changes/journal.ts');
  const adapter = await source('changes/vscodeJournal.ts');
  assert.match(core, /melink\.changeJournal/);
  assert.match(adapter, /workspaceState\.update/);
  assert.equal(/\.globalState\b/.test(adapter), false);
});

test('the tracker and watch session are host-free, so they are unit-testable', async () => {
  const tracker = await source('changes/tracker.ts');
  const watch = await source('changes/watchSession.ts');
  for (const text of [tracker, watch]) {
    assert.equal(/\bfrom\s+['"]vscode['"]/.test(text), false);
    assert.equal(/\bconsole\./.test(text), false);
  }
});

test('the change payloads are the vendored generated schemas, not hand-rolled shapes', async () => {
  const mapping = await source('backends/appserver/reportedChanges.ts');
  // The mapper consumes the generated `FileChange` / `FileUpdateChange` /
  // `FileChangePatchUpdatedNotification` types rather than re-declaring them.
  assert.match(mapping, /schemas\/FileChange/);
  assert.match(mapping, /schemas\/v2\/FileUpdateChange/);
  assert.match(mapping, /schemas\/v2\/FileChangePatchUpdatedNotification/);
});

test('the watcher is bound to vscode.workspace.createFileSystemWatcher and disposed', async () => {
  const adapter = await source('changes/vscodeChanges.ts');
  assert.match(adapter, /vscode\.workspace\.createFileSystemWatcher/);
  assert.match(adapter, /dispose\(\)/);
  // It never imports a direct fs: the watcher is the only observation channel.
  assert.equal(/from\s+['"]node:fs['"]/.test(adapter), false);
});

test('the changes protocol message carries a snapshot and is host-pushed only', async () => {
  const protocol = await source('protocol.ts');
  assert.match(protocol, /type: 'changes\/changed'/);
  // The webview never requests a file list ad hoc: the message is host-to-webview.
  const webviewToHost = protocol.slice(protocol.indexOf('WebviewToHostMessage'));
  assert.equal(/changes\/changed/.test(webviewToHost), false);
});

test('the diff engine is host-free and adds no runtime dependency', async () => {
  const diff = await source('changes/diff.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(diff), false);
  assert.equal(/\bconsole\./.test(diff), false);
  // It must not reach for a diff package: the algorithm is in-repo.
  assert.equal(/from\s+['"](diff|fast-diff|diff-match-patch|jsdiff)['"]/.test(diff), false);
  assert.match(diff, /function myers/);
});

test('the decision store is host-free; only its vscode binding imports vscode', async () => {
  const store = await source('changes/changeStore.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(store), false);
  assert.equal(/\bconsole\./.test(store), false);
  // No direct fs: all workspace I/O goes through the injected seam.
  assert.equal(/from\s+['"]node:fs['"]/.test(store), false);
  assert.equal(/from\s+['"]fs['"]/.test(store), false);
  const binding = await source('changes/vscodeChangeStore.ts');
  assert.match(binding, /vscode\.workspace\.fs\.writeFile/);
  assert.match(binding, /vscode\.workspace\.fs\.delete/);
});

test('the decision store records accept/reject but never auto-decides', async () => {
  const store = await source('changes/changeStore.ts');
  // Decisions are persisted under a workspaceState key, never globalState.
  assert.match(store, /CHANGE_DECISIONS_KEY = 'melink\.changeDecisions'/);
  assert.equal(/\.globalState\b/.test(store), false);
  assert.equal(/\bsetTimeout\b|\bsetInterval\b/.test(store), false);
});

test('the change-review snapshot is pushed through one host helper', async () => {
  const view = await source('sidebarView.ts');
  assert.match(view, /private async postChangeReview\(/);
  // Every review push goes through that helper rather than posting ad hoc.
  const adHoc = view.match(/type: 'changes\/review'/g) ?? [];
  assert.equal(adHoc.length, 1, 'only postChangeReview posts a review snapshot');
});

test('the checkpoint core is host-free and reverts files only', async () => {
  const store = await source('changes/checkpoint.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(store), false);
  assert.equal(/\bconsole\./.test(store), false);
  assert.equal(/from\s+['"]node:fs['"]/.test(store), false);
  assert.equal(/from\s+['"]fs['"]/.test(store), false);
  // The store never touches the transcript: no ThreadStore import. The word may
  // appear only in comments that document the guarantee, never in an import.
  assert.equal(/from\s+['"][^'"]*threadStore/.test(store), false);
  assert.equal(/import[^;]*Transcript/i.test(store), false);
});

test('restoring a checkpoint always captures a pre-restore snapshot before writing', async () => {
  const store = await source('changes/checkpoint.ts');
  // The capture is attempted before any workspace write call, and a failed
  // capture aborts without a write.
  const captureIndex = store.indexOf('captureRestorePoint');
  const writeIndex = store.indexOf('this.fs.writeFile');
  assert.ok(captureIndex !== -1 && writeIndex !== -1);
  assert.ok(captureIndex < writeIndex, 'the undo snapshot is captured before any write');
  assert.match(store, /aborted: true/);
});

test('the checkpoint protocol messages are typed and only the restored thread is truncated', async () => {
  const protocol = await source('protocol.ts');
  assert.match(protocol, /type: 'changes\/listCheckpoints'/);
  assert.match(protocol, /type: 'changes\/previewRestore'/);
  assert.match(protocol, /type: 'changes\/restoreCheckpoint'/);
  assert.match(protocol, /type: 'changes\/restoreResult'/);
  const view = await source('sidebarView.ts');
  assert.match(view, /truncateBeforeMessage\(message\.backendId, message\.threadId, message\.messageId\)/);
  assert.doesNotMatch(view, /clearTranscript|deleteThread/);
});

test('the native diff planner is host-free and writes no temp file', async () => {
  const core = await source('changes/nativeDiff.ts');
  assert.equal(/\bfrom\s+['"]vscode['"]/.test(core), false);
  assert.equal(/\bconsole\./.test(core), false);
  assert.equal(/from\s+['"]node:fs['"]/.test(core), false);
  assert.equal(/from\s+['"]fs['"]/.test(core), false);
  assert.match(core, /melink-changes/);
});

test('the native diff binding serves content read-only from the journal, never the filesystem', async () => {
  const binding = await source('changes/vscodeDiff.ts');
  // One content provider, registered and disposed with the service.
  assert.match(binding, /registerTextDocumentContentProvider/);
  assert.match(binding, /dispose\(\)/);
  // The diff is opened through the built-in workbench commands.
  assert.match(binding, /'vscode\.diff'/);
  assert.match(binding, /'vscode\.changes'/);
  // No direct fs and no workspace write: the only file I/O is a read-only open.
  assert.equal(/from\s+['"]node:fs['"]/.test(binding), false);
  assert.equal(/from\s+['"]fs['"]/.test(binding), false);
  assert.equal(/workspace\.fs\.writeFile/.test(binding), false);
});

test('the native diff command ids are registered and the webview never computes a diff', async () => {
  const core = await source('changes/nativeDiff.ts');
  for (const id of ['melink.openChangeDiff', 'melink.openTurnChanges', 'melink.revealChangeInSourceControl']) {
    assert.match(core, new RegExp(id.replace(/\./g, '\\.')));
  }
  const binding = await source('changes/vscodeDiff.ts');
  assert.match(binding, /registerCommand\(OPEN_CHANGE_DIFF_COMMAND/);
  assert.match(binding, /registerCommand\(OPEN_TURN_CHANGES_COMMAND/);
  assert.match(binding, /registerCommand\(REVEAL_CHANGE_IN_SCM_COMMAND/);
  const protocol = await source('protocol.ts');
  assert.match(protocol, /type: 'changes\/openDiff'/);
  assert.match(protocol, /type: 'changes\/openView'/);
  assert.match(protocol, /type: 'changes\/reveal'/);
});
