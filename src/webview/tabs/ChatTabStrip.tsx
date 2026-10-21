import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { CrossIcon } from '../Icons';
import { bridge } from '../hostBridge';
import type { AppState } from '../state';

export function dropIndex(ids: readonly string[], dragId: string, overId: string, before: boolean): number {
  const from = ids.indexOf(dragId);
  let to = ids.indexOf(overId);
  if (from < 0 || to < 0) {
    return -1;
  }
  if (!before) {
    to += 1;
  }
  if (from < to) {
    to -= 1;
  }
  return to;
}

/** Keep a tab fully inside the horizontal strip without scrolling the page. */
export function revealChatTab(list: HTMLElement, tab: HTMLElement): boolean {
  if (list.clientWidth === 0) {
    return false;
  }
  const pad = 4;
  const listRect = list.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.left < listRect.left + pad) {
    list.scrollLeft -= listRect.left + pad - tabRect.left;
  } else if (tabRect.right > listRect.right - pad) {
    list.scrollLeft += tabRect.right - (listRect.right - pad);
  }
  return true;
}

export function ChatTabStrip({
  tabs,
  activity,
  actions
}: {
  tabs: AppState['chatTabs'];
  activity: AppState['threadActivity'];
  actions: JSX.Element;
}): JSX.Element | null {
  const stripRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null);
  const activeId = tabs.find((tab) => tab.active)?.id ?? '';
  const activeIndex = tabs.findIndex((tab) => tab.active);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) {
      return;
    }
    const tab = list.querySelector<HTMLElement>(`[data-chat-tab-id="${CSS.escape(activeId)}"]`);
    if (!tab) {
      return;
    }
    let frame = 0;
    let attempts = 0;
    const reveal = (): void => {
      if (revealChatTab(list, tab) || attempts >= 8) {
        return;
      }
      attempts += 1;
      frame = requestAnimationFrame(reveal);
    };
    reveal();
    const observer = new ResizeObserver(() => {
      revealChatTab(list, tab);
    });
    observer.observe(list);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeId, activeIndex, tabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    const list = listRef.current;
    if (!strip || !list) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      if (list.scrollWidth <= list.clientWidth) {
        return;
      }
      const axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (axis === 0) {
        return;
      }
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? axis * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? axis * list.clientWidth
            : axis;
      event.preventDefault();
      list.scrollLeft += delta;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [tabs.length]);

  if (tabs.length === 0) {
    return null;
  }
  const finishDrag = (): void => {
    setDragId(null);
    setOver(null);
  };
  return (
    <div className="chat-tabs" ref={stripRef}>
      <div className="chat-tabs__list" role="tablist" aria-label="Open chats" ref={listRef}>
        {tabs.map((tab) => {
          const key = tab.backendId && tab.threadId ? `${tab.backendId}:${tab.threadId}` : undefined;
          const live = key ? activity[key] : undefined;
          const drop =
            over?.id === tab.id ? (over.before ? ' chat-tab--drop-before' : ' chat-tab--drop-after') : '';
          const dragging = dragId === tab.id ? ' chat-tab--dragging' : '';
          return (
            <div
              className={`chat-tab${tab.active ? ' chat-tab--active' : ''}${drop}${dragging}`}
              key={tab.id}
              data-chat-tab-id={tab.id}
              draggable
              onMouseDown={(event) => {
                if (event.button !== 1) {
                  return;
                }
                event.preventDefault();
                bridge.post({ type: 'closeChatTab', tabId: tab.id });
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                }
              }}
              onDragStart={(event) => {
                if ((event.target as HTMLElement).closest('.chat-tab__close')) {
                  event.preventDefault();
                  return;
                }
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
                setDragId(tab.id);
              }}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                setOver((current) =>
                  current?.id === tab.id && current.before === before ? current : { id: tab.id, before }
                );
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = event.dataTransfer.getData('text/plain') || dragId;
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                if (source) {
                  const to = dropIndex(
                    tabs.map((item) => item.id),
                    source,
                    tab.id,
                    before
                  );
                  if (to >= 0) {
                    bridge.post({ type: 'reorderChatTab', tabId: source, toIndex: to });
                  }
                }
                finishDrag();
              }}
            >
              <button
                className="chat-tab__label"
                type="button"
                role="tab"
                aria-selected={tab.active}
                title={tab.title}
                onClick={() => bridge.post({ type: 'selectChatTab', tabId: tab.id })}
              >
                <span className="chat-tab__text">{tab.title}</span>
                {live?.busy ? (
                  <span className="chat-tab__mark" role="status" title="Busy" aria-label="Busy">
                    <span className="spinner" aria-hidden="true" />
                  </span>
                ) : null}
                {!tab.active && live?.unread ? <span className="chat-tab__unread" title="Unread" aria-label="Unread" /> : null}
              </button>
              <button
                className="chat-tab__close"
                type="button"
                aria-label={`Close ${tab.title}`}
                draggable={false}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  if (event.button === 1) {
                    event.preventDefault();
                    bridge.post({ type: 'closeChatTab', tabId: tab.id });
                  }
                }}
                onClick={() => bridge.post({ type: 'closeChatTab', tabId: tab.id })}
              >
                <CrossIcon />
              </button>
            </div>
          );
        })}
      </div>
      {actions}
    </div>
  );
}

