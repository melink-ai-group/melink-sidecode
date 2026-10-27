import type { FileReference } from './fileReferences';
import { bridge } from './hostBridge';

/** Ask the host to open one file reference in the editor. */
export function openFileReference(reference: FileReference): void {
  if (!reference.path) {
    return;
  }
  bridge.post({
    type: 'openFile',
    path: reference.path,
    ...(reference.line !== undefined ? { line: reference.line } : {}),
    ...(reference.column !== undefined ? { column: reference.column } : {})
  });
}

/** Ask the host to open one http(s) link in the editor's internal browser. */
export function openWebLink(url: string): void {
  if (!url) {
    return;
  }
  bridge.post({ type: 'openLink', url });
}
