/**
 * Geometry helpers for the browser panel's inline script.
 *
 * Each function is serialized with `Function.prototype.toString` into the
 * panel, so it must stay self-contained: no imports and no outer references.
 * Keeping them here makes the letterbox maths, selection clamping, and wheel
 * units testable without VS Code or a browser.
 */

export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The visible rectangle of an `object-fit: contain` image, in client pixels. */
export interface DrawnFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point inside the page viewport, from 0 to 1. */
export interface FractionPoint {
  x: number;
  y: number;
}

/** A rectangle inside the page viewport, all fields from 0 to 1. */
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The painted area of the page image. The `<img>` is contained in the stage, so
 * a wider or taller stage leaves letterbox bars; clicks and selections must be
 * mapped onto the painted rectangle rather than the whole element.
 */
export function drawnFrame(
  rect: ClientRectLike,
  naturalWidth: number,
  naturalHeight: number
): DrawnFrame | undefined {
  if (!(rect.width > 0) || !(rect.height > 0) || !(naturalWidth > 0) || !(naturalHeight > 0)) {
    return undefined;
  }
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height
  };
}

/** A client point as a viewport fraction, or undefined outside the page image. */
export function pointFraction(
  frame: DrawnFrame,
  clientX: number,
  clientY: number
): FractionPoint | undefined {
  const x = (clientX - frame.left) / frame.width;
  const y = (clientY - frame.top) / frame.height;
  if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) {
    return undefined;
  }
  return { x, y };
}

/** A client point clamped onto the page image, for a release outside it. */
export function clampedFraction(
  frame: DrawnFrame,
  clientX: number,
  clientY: number
): FractionPoint {
  return {
    x: Math.min(1, Math.max(0, (clientX - frame.left) / frame.width)),
    y: Math.min(1, Math.max(0, (clientY - frame.top) / frame.height))
  };
}

/**
 * A drag between two client points as a viewport rectangle.
 *
 * The rectangle is clamped to the page image, reversed drags are normalized,
 * and a drag shorter than two CSS pixels in either direction is not a
 * selection. `undefined` means the pointer never described a usable area.
 */
export function selectionFraction(
  frame: DrawnFrame,
  start: { clientX: number; clientY: number },
  end: { clientX: number; clientY: number }
): SelectionRect | undefined {
  const left = Math.max(frame.left, Math.min(start.clientX, end.clientX));
  const right = Math.min(frame.left + frame.width, Math.max(start.clientX, end.clientX));
  const top = Math.max(frame.top, Math.min(start.clientY, end.clientY));
  const bottom = Math.min(frame.top + frame.height, Math.max(start.clientY, end.clientY));
  const width = right - left;
  const height = bottom - top;
  if (!(width >= 2) || !(height >= 2)) {
    return undefined;
  }
  return {
    x: (left - frame.left) / frame.width,
    y: (top - frame.top) / frame.height,
    width: width / frame.width,
    height: height / frame.height
  };
}

/**
 * Wheel deltas in CSS pixels. Browsers report pixels, lines, or pages depending
 * on the device and platform; Playwright always expects pixels.
 */
export function wheelPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  viewportHeight: number
): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
  return { dx: event.deltaX * unit, dy: event.deltaY * unit };
}

/**
 * Bind serialized helper functions to the names the panel script calls.
 *
 * `Function.prototype.toString` on a bundled function can carry a minified
 * name (`function gg(...)`), so an alias declared here is what keeps the
 * panel's calls working in a production build.
 */
export function bindHelpers(
  entries: ReadonlyArray<readonly [name: string, helper: { toString(): string }]>
): string {
  return entries.map(([name, helper]) => `const ${name} = ${helper.toString()};`).join('\n');
}

/**
 * A CSS cursor value from the page, restricted to keywords.
 *
 * The page's computed cursor is applied to the image so hover states look
 * native. A `url(...)` cursor is dropped: it could point anywhere, and the
 * panel only needs the familiar keyword cursors.
 */
export function safeCursor(value: unknown): string {
  if (typeof value !== 'string' || value === 'auto') {
    return 'default';
  }
  return /^[a-z-]+$/.test(value) ? value : 'default';
}
