import { CheckpointStore, type CheckpointStoreOptions } from './checkpoint';
import { VscodeWorkspaceFs } from './vscodeChangeStore';

/**
 * The one binding from the real VS Code API to the host-free `CheckpointStore`.
 *
 * It only supplies the workspace file seam: the journal (restore points and
 * recorded before/after bytes) and the decision store are injected by the host,
 * which already owns the shared journal instance. No new dependency and no
 * direct `fs` is introduced; workspace reads and writes go through
 * `vscode.workspace.fs` exactly as the review path does.
 */
export class VscodeCheckpointStore extends CheckpointStore {
  constructor(options: Omit<CheckpointStoreOptions, 'fs'>) {
    super({ ...options, fs: new VscodeWorkspaceFs() });
  }
}
