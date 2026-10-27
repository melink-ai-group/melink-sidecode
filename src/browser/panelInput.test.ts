import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindHelpers,
  clampedFraction,
  drawnFrame,
  pointFraction,
  safeCursor,
  selectionFraction,
  wheelPixels
} from './panelInput.ts';

const stage = { left: 20, top: 40, width: 1000, height: 600 };

test('the painted frame removes the letterbox bars of a contained image', () => {
  const frame = drawnFrame(stage, 1280, 800);
  assert.deepEqual(frame, { left: 40, top: 40, width: 960, height: 600 });
});

test('the painted frame uses the full height when the image is wider than the stage', () => {
  const frame = drawnFrame(stage, 800, 400);
  assert.deepEqual(frame, { left: 20, top: 90, width: 1000, height: 500 });
});

test('an image without a size has no painted frame', () => {
  assert.equal(drawnFrame({ left: 0, top: 0, width: 0, height: 0 }, 1280, 800), undefined);
  assert.equal(drawnFrame(stage, 0, 0), undefined);
});

test('a point maps onto the painted frame and outside it is dropped', () => {
  const frame = { left: 20, top: 40, width: 960, height: 600 };
  assert.deepEqual(pointFraction(frame, 500, 340), { x: 0.5, y: 0.5 });
  assert.deepEqual(pointFraction(frame, 20, 40), { x: 0, y: 0 });
  assert.deepEqual(pointFraction(frame, 980, 640), { x: 1, y: 1 });
  assert.equal(pointFraction(frame, 10, 340), undefined);
  assert.equal(pointFraction(frame, 500, 650), undefined);
});

test('a release outside the frame is clamped onto the page', () => {
  const frame = { left: 20, top: 40, width: 960, height: 600 };
  assert.deepEqual(clampedFraction(frame, -100, 1000), { x: 0, y: 1 });
  assert.deepEqual(clampedFraction(frame, 500, 340), { x: 0.5, y: 0.5 });
});

test('a drag becomes a normalized rectangle clamped to the page', () => {
  const frame = { left: 20, top: 40, width: 960, height: 600 };
  const rect = selectionFraction(frame, { clientX: 260, clientY: 190 }, { clientX: 740, clientY: 490 });
  assert.deepEqual(rect, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });

  const reversed = selectionFraction(frame, { clientX: 740, clientY: 490 }, { clientX: 260, clientY: 190 });
  assert.deepEqual(reversed, rect);

  const beyond = selectionFraction(frame, { clientX: 0, clientY: 0 }, { clientX: 2000, clientY: 2000 });
  assert.deepEqual(beyond, { x: 0, y: 0, width: 1, height: 1 });
});

test('a click or a sliver is not a selection', () => {
  const frame = { left: 20, top: 40, width: 960, height: 600 };
  assert.equal(selectionFraction(frame, { clientX: 500, clientY: 340 }, { clientX: 500, clientY: 340 }), undefined);
  assert.equal(selectionFraction(frame, { clientX: 500, clientY: 340 }, { clientX: 501, clientY: 380 }), undefined);
  assert.equal(selectionFraction(frame, { clientX: 500, clientY: 340 }, { clientX: 540, clientY: 341 }), undefined);
});

test('wheel deltas become CSS pixels for pixels, lines, and pages', () => {
  assert.deepEqual(wheelPixels({ deltaX: 3, deltaY: -4, deltaMode: 0 }, 800), { dx: 3, dy: -4 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 2, deltaMode: 1 }, 800), { dx: 0, dy: 32 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 800), { dx: 0, dy: 800 });
  assert.deepEqual(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 0), { dx: 0, dy: 1 });
});

test('only keyword cursors from the page are applied to the image', () => {
  assert.equal(safeCursor('pointer'), 'pointer');
  assert.equal(safeCursor('col-resize'), 'col-resize');
  assert.equal(safeCursor('zoom-in'), 'zoom-in');
  assert.equal(safeCursor('auto'), 'default');
  assert.equal(safeCursor('url(http://example.com/a.cur), auto'), 'default');
  assert.equal(safeCursor(undefined), 'default');
  assert.equal(safeCursor(42), 'default');
});

test('serialized helpers keep the callable name when the bundler renames the body', () => {
  function gg(value: { x: number }): { x: number } {
    return value;
  }
  const source = bindHelpers([['drawnFrame', gg]]);
  assert.match(source, /^const drawnFrame = function gg\(/);
  const run = new Function(`${source}\nreturn drawnFrame({ x: 1 });`) as () => { x: number };
  assert.deepEqual(run(), { x: 1 });
});
