import type { JSX } from 'react';
import type { RestoreCheckpointResult } from '../../protocol';
import { RestoreIcon } from '../Icons';

/**
 * The result strip for a checkpoint restore, so a partial outcome is never
 * hidden and the restore can be undone. It states plainly that only files were
 * reverted, and lists the paths that failed or were left as conflicts.
 */
export function RestoreResultStrip({
  result,
  onUndo
}: {
  result: RestoreCheckpointResult;
  onUndo: () => void;
}): JSX.Element {
  const failed = result.results.filter((entry) => entry.outcome === 'failed');
  const conflicts = result.results.filter((entry) => entry.outcome === 'conflict');
  const skipped = result.results.filter((entry) => entry.outcome === 'skipped');
  const problems = [...failed, ...conflicts, ...skipped];
  return (
    <div className={`banner banner--${result.partial ? 'interrupted' : 'ok'}`} role="status">
      <span className="banner-icon" aria-hidden="true">
        <RestoreIcon />
      </span>
      <div>
        <p className="banner-title">{result.partial ? 'Restore was partial' : 'Files restored'}</p>
        <p className="banner-text">{result.message}</p>
        {problems.length > 0 ? (
          <ul className="restore-problems">
            {problems.slice(0, 8).map((entry) => (
              <li key={entry.relPath}>
                <span className="restore-problems__path">{entry.relPath}</span>
                {entry.reason ? <span className="restore-problems__reason"> {entry.reason}</span> : null}
              </li>
            ))}
            {problems.length > 8 ? <li>and {problems.length - 8} more</li> : null}
          </ul>
        ) : null}
        <div className="banner-actions">
          <button className="btn btn--quiet" type="button" onClick={onUndo}>
            Undo restore
          </button>
        </div>
      </div>
    </div>
  );
}

