import { useEffect, useRef, type JSX } from 'react';
import type { Attachment } from '../../backends/types';
import { MAX_ATTACHMENT_BYTES, kindForMime, mimeForName } from '../../attachments';
import { ChevronRightIcon, CrossIcon, PaperclipIcon } from '../Icons';
import { trapTab } from '../focusTrap';

/**
 * Turn one clipboard `File` into an attachment with its bytes. Images also
 * use that data URL for the preview; other files keep the existing file icon.
 * Returns `undefined` for an oversized or unreadable file so the caller can
 * report it and add nothing.
 */
export function readClipboardFile(file: File): Promise<Attachment | undefined> {
  const name = file.name && file.name.trim().length > 0 ? file.name : defaultPastedName(file.type);
  const mimeType = file.type || mimeForName(name);
  const base = {
    id: `paste_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    mimeType,
    size: file.size,
    kind: kindForMime(mimeType)
  } satisfies Attachment;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : undefined;
      const offset = result?.indexOf(';base64,') ?? -1;
      resolve(result && offset >= 0 ? { ...base, dataUrl: `data:${mimeType};base64,${result.slice(offset + 8)}` } : undefined);
    };
    reader.onerror = () => resolve(undefined);
    try {
      reader.readAsDataURL(file);
    } catch {
      resolve(undefined);
    }
  });
}

/** A readable fallback name for a clipboard file the browser left unnamed. */
export function defaultPastedName(mimeType: string): string {
  if (mimeType.startsWith('image/')) {
    return `pasted-image.${mimeType.slice('image/'.length) || 'png'}`;
  }
  if (mimeType.startsWith('audio/')) {
    return `pasted-audio.${mimeType.slice('audio/'.length) || 'bin'}`;
  }
  return 'pasted-file';
}


/** An image the viewer can show. `src` is a data URL already held in the webview. */
export type ViewableImage = { id: string; src: string; name: string };

export function viewableImages(attachments: Attachment[]): ViewableImage[] {
  return attachments.flatMap((attachment) =>
    attachment.kind === 'image' && attachment.dataUrl
      ? [{ id: attachment.id, src: attachment.dataUrl, name: attachment.name }]
      : []
  );
}

export function AttachmentList({
  attachments,
  sent,
  onRemove,
  onView
}: {
  attachments: Attachment[];
  sent?: boolean;
  onRemove?: (id: string) => void;
  onView: (images: ViewableImage[], index: number) => void;
}): JSX.Element {
  const images = viewableImages(attachments);
  return (
    <ul className={sent ? 'attachments attachments--sent' : 'attachments'} aria-label="Attachments">
      {attachments.map((attachment) => {
        const imageIndex = images.findIndex((image) => image.id === attachment.id);
        const preview = imageIndex >= 0 ? images[imageIndex] : undefined;
        return (
          <li className="attachment" key={attachment.id}>
            {preview ? (
              <button
                className="attachment-open"
                type="button"
                aria-label={`View ${attachment.name}`}
                onClick={() => onView(images, imageIndex)}
              >
                <img className="attachment-thumb" src={preview.src} alt="" />
              </button>
            ) : (
              <span className="attachment-fallback" title={attachment.name} aria-label={attachment.name}>
                <PaperclipIcon />
              </span>
            )}
            {onRemove ? (
              <button
                className="attachment-remove"
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
              >
                <CrossIcon />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ImageViewer({
  images,
  index,
  onIndex,
  onClose
}: {
  images: ViewableImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const current = images[Math.min(Math.max(index, 0), images.length - 1)];
  const several = images.length > 1;

  useEffect(() => {
    const invoking = document.activeElement;
    restoreRef.current = invoking instanceof HTMLElement ? invoking : null;
    closeRef.current?.focus();
    return () => {
      const target = restoreRef.current;
      if (target?.isConnected) {
        target.focus();
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Tab') {
        trapTab(event, dialogRef.current);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft' && several) {
        event.preventDefault();
        onIndex((index - 1 + images.length) % images.length);
      } else if (event.key === 'ArrowRight' && several) {
        event.preventDefault();
        onIndex((index + 1) % images.length);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, index, onClose, onIndex, several]);

  return (
    <div className="image-viewer" role="presentation" onClick={onClose}>
      <div
        className="image-viewer__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current?.name ?? 'Image'}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        {several ? (
          <button
            className="image-viewer__nav image-viewer__nav--prev"
            type="button"
            aria-label="Previous image"
            onClick={() => onIndex((index - 1 + images.length) % images.length)}
          >
            <ChevronRightIcon />
          </button>
        ) : null}
        {current ? <img className="image-viewer__image" src={current.src} alt={current.name} /> : null}
        {several ? (
          <button
            className="image-viewer__nav image-viewer__nav--next"
            type="button"
            aria-label="Next image"
            onClick={() => onIndex((index + 1) % images.length)}
          >
            <ChevronRightIcon />
          </button>
        ) : null}
        <button className="image-viewer__close" type="button" aria-label="Close image" ref={closeRef} onClick={onClose}>
          <CrossIcon />
        </button>
      </div>
    </div>
  );
}
