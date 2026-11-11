import type { JSX } from 'react';
import { friendlyToolTitle, isRawToolName } from '../../backends/toolLabel.ts';
import { openFileReference } from '../navigation';
import { prettyPath } from '../prettyPath';
import { FileIcon } from '../Icons';
import type { TranscriptItemView } from '../state';
import { CardLines, StatusChip, diffStatsLabel, filePathLabel, totals } from './shared';

export function FileChangeCard({ item }: { item: TranscriptItemView }): JSX.Element {
  const files = item.files ?? [];
  const diffs = files.filter((file) => file.lines && file.lines.length > 0);
  const rawTitle = item.title?.trim();
  const title =
    rawTitle && isRawToolName(rawTitle)
      ? friendlyToolTitle(rawTitle, files[0]?.path)
      : rawTitle || 'Edited';
  const head = (
    <>
      <span className="item-icon" aria-hidden="true">
        <FileIcon />
      </span>
      <CardLines title={title} detail={filePathLabel(files)} />
      {totals(files) ? (
        <span className="diff-stats" aria-label={diffStatsLabel(files)}>
          {totals(files)?.additions ? <span className="add">+{totals(files)?.additions}</span> : null}
          {totals(files)?.deletions ? <span className="del">-{totals(files)?.deletions}</span> : null}
        </span>
      ) : null}
      <StatusChip status={item.status} doneLabel="Applied" />
    </>
  );
  const panel = diffs.length > 0 ? (
    <div className="item-card diff-body" role="figure" aria-label={`Diff for ${diffs.length} changed ${diffs.length === 1 ? 'file' : 'files'}`}>
      {diffs.map((file) => (
        <section className="diff-file" key={file.path}>
          {diffs.length > 1 ? (
            <button
              className="diff-file__path"
              type="button"
              title={`Open ${prettyPath(file.path)}`}
              aria-label={`Open ${prettyPath(file.path)}`}
              onClick={() => openFileReference({ path: file.path })}
            >
              {prettyPath(file.path)}
            </button>
          ) : null}
          {file.lines?.map((line, index) => (
            <div className={`diff-line diff-line--${line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'ctx'}`} key={`${index}-${line.kind}`}>
              <span className="sign" aria-hidden="true">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  ) : item.text ? (
    <div className="item-card">
      <div className="item-body">
        <code>{item.text}</code>
      </div>
    </div>
  ) : null;
  if (!panel) {
    return (
      <div className="activity-row activity-row--change">
        <div className="activity-row__head">{head}</div>
      </div>
    );
  }
  return (
    <details className="activity-row activity-row--change">
      <summary className="activity-row__head">{head}</summary>
      {panel}
    </details>
  );
}
