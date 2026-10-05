import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ChangeEntry } from '../backends/types';
import type { ChangeFileView } from '../changes/changeStore';

interface ChangedFilesStripProps {
  entries: ChangeEntry[];
  files?: ChangeFileView[];
  onOpenFile: (path: string) => void;
  children?: ReactNode;
}

/** Compact composer-side index of the most recent verified file changes. */
export function ChangedFilesStrip({ entries, files = [], onOpenFile, children }: ChangedFilesStripProps) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) {
    return null;
  }

  const details = new Map(files.map((file) => [file.absPath, file]));
  if (children) {
    return (
      <section className="changed-files" aria-label="Changed files">
        <div className="changed-files__review">{children}</div>
      </section>
    );
  }

  return (
    <section className={`changed-files${open ? ' is-open' : ''}`} aria-label="Changed files">
      <button
        className="changed-files__toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{entries.length} {entries.length === 1 ? 'file' : 'files'} changed</span>
        <span className="changed-files__hint">{open ? 'Hide' : 'Review files'}</span>
      </button>
      {open ? (
        <div className="changed-files__panel">
        <ul className="changed-files__list" aria-label="Files changed in this session">
          {entries.map((entry) => {
            const file = details.get(entry.absPath);
            const status = file?.status ?? entry.status;
            const stats = status === 'created'
              ? <span className="changed-files__status">Added</span>
              : status === 'deleted'
                ? <span className="changed-files__status">Deleted</span>
                : file
                  ? <><span className="add">+{file.additions}</span><span className="del">−{file.deletions}</span></>
                  : <span className="changed-files__status">{status}</span>;
            return (
              <li key={`${entry.absPath}:${entry.status}`}>
                <button
                  className="changed-files__file"
                  type="button"
                  title={entry.path}
                  onClick={() => onOpenFile(entry.absPath)}
                >
                  <span className="changed-files__path">{entry.path}</span>
                  <span className="changed-files__stats" aria-label={status === 'created' ? 'Added' : status === 'deleted' ? 'Deleted' : file ? `${file.additions} additions, ${file.deletions} deletions` : status}>
                    {stats}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        </div>
      ) : null}
    </section>
  );
}
