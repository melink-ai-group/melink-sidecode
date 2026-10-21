import type { JSX } from 'react';
import { SearchIcon } from '../Icons';
import { isSubmitEnter } from '../keys';
import type { HistoryEntry } from '../historyEntries';
import type { AppState } from '../state';

export function HistoryPanel({
  threads,
  loading,
  activeThreadId,
  selectedBackendId,
  threadActivity,
  query,
  onQueryChange,
  onSelect
}: {
  threads: HistoryEntry[];
  loading: boolean;
  activeThreadId?: string;
  selectedBackendId?: string;
  threadActivity: AppState['threadActivity'];
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (backendId: string, threadId: string) => void;
}): JSX.Element {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? threads.filter((thread) => (thread.title ?? 'Untitled conversation').toLowerCase().includes(needle))
    : threads;
  return (
    <div className="history-menu" id="history-panel">
      <div className="history-menu__search">
        <SearchIcon />
        <input
          className="model-filter"
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={query}
          autoFocus
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (isSubmitEnter(event) && visible[0]) {
              event.preventDefault();
              onSelect(visible[0].backendId, visible[0].threadId);
            }
          }}
        />
      </div>
      {loading && threads.length === 0 ? (
        <div className="history-loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          Loading conversations...
        </div>
      ) : threads.length === 0 ? (
        <ul className="model-list">
          <li className="model-option model-option--empty">No earlier conversations yet.</li>
        </ul>
      ) : visible.length === 0 ? (
        <ul className="model-list">
          <li className="model-option model-option--empty">No conversations match.</li>
        </ul>
      ) : (
        <ul className="model-list" role="listbox" aria-label="Conversations">
          {visible.map((thread) => {
            const selected = thread.backendId === selectedBackendId && thread.threadId === activeThreadId;
            const activity = threadActivity?.[`${thread.backendId}:${thread.threadId}`];
            const title = thread.title ?? 'Untitled conversation';
            return (
              <li
                className="model-option"
                role="option"
                aria-selected={selected}
                key={`${thread.backendId}:${thread.threadId}`}
                tabIndex={0}
                onClick={() => onSelect(thread.backendId, thread.threadId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(thread.backendId, thread.threadId);
                  }
                }}
              >
                <span className="thread-title" title={title}>
                  {title}
                </span>
                {activity?.busy ? (
                  <span className="chat-tab__mark" role="status" title="Busy" aria-label="Busy">
                    <span className="spinner" aria-hidden="true" />
                  </span>
                ) : null}
                {!selected && activity?.unread ? (
                  <span className="chat-tab__unread" title="Unread" role="img" aria-label="Unread" />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

