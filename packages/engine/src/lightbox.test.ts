import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPan,
  clampZoom,
  LIGHTBOX_MAX_ZOOM,
  LIGHTBOX_MIN_ZOOM,
  LIGHTBOX_REST,
  reduceLightboxPan,
  reduceLightboxZoom,
  zoomFactorFromWheel,
} from "./lightbox.ts";

const VIEW = { width: 1000, height: 800 };

test("clampZoom bounds and rejects non-finite values", () => {
  assert.equal(clampZoom(0.2), LIGHTBOX_MIN_ZOOM);
  assert.equal(clampZoom(99), LIGHTBOX_MAX_ZOOM);
  assert.equal(clampZoom(2.5), 2.5);
  assert.equal(clampZoom(Number.NaN), LIGHTBOX_MIN_ZOOM);
});

test("zoomFactorFromWheel zooms in on scroll up and composes across small deltas", () => {
  assert.ok(zoomFactorFromWheel(-100) > 1, "scroll up zooms in");
  assert.ok(zoomFactorFromWheel(100) < 1, "scroll down zooms out");
  // Ten trackpad ticks of 10 equal one notch of 100 (multiplicative accumulation).
  const composed = Array.from({ length: 10 }, () => zoomFactorFromWheel(-10)).reduce(
    (acc, factor) => acc * factor,
    1,
  );
  assert.ok(Math.abs(composed - zoomFactorFromWheel(-100)) < 1e-12);
});

test("clampPan pins to 0 at zoom 1 and bounds travel by the overflow", () => {
  assert.equal(clampPan(50, 1, VIEW.width), 0);
  // zoom 2 over a 1000px extent → ±500 travel.
  assert.equal(clampPan(700, 2, VIEW.width), 500);
  assert.equal(clampPan(-700, 2, VIEW.width), -500);
  assert.equal(clampPan(123, 2, VIEW.width), 123);
  assert.equal(clampPan(Number.NaN, 2, VIEW.width), 0);
});

test("reduceLightboxZoom keeps the cursor's image point fixed", () => {
  const start = { zoom: 2, panX: 100, panY: -50 };
  const cursor = { x: 200, y: 150 };
  const next = reduceLightboxZoom(start, 1.5, cursor.x, cursor.y, VIEW.width, VIEW.height);
  assert.equal(next.zoom, 3);
  // The image point under the cursor: (cursor - pan) / zoom — unchanged.
  const before = (cursor.x - start.panX) / start.zoom;
  const after = (cursor.x - next.panX) / next.zoom;
  assert.ok(Math.abs(before - after) < 1e-9);
});

test("reduceLightboxZoom clamps at max zoom and re-clamps pan when zooming out", () => {
  const maxed = reduceLightboxZoom(
    { zoom: 6, panX: 0, panY: 0 },
    10,
    0,
    0,
    VIEW.width,
    VIEW.height,
  );
  assert.equal(maxed.zoom, LIGHTBOX_MAX_ZOOM);
  // Fully zoomed out always lands exactly at rest, wherever the pan was.
  const rest = reduceLightboxZoom(
    { zoom: 2, panX: 400, panY: -300 },
    0.01,
    0,
    0,
    VIEW.width,
    VIEW.height,
  );
  assert.deepEqual(rest, LIGHTBOX_REST);
});

test("reduceLightboxPan applies the drag and clamps at the edges", () => {
  const start = { zoom: 2, panX: 450, panY: 0 };
  const next = reduceLightboxPan(start, 200, -100, VIEW.width, VIEW.height);
  assert.equal(next.panX, 500, "clamped at the +x edge");
  assert.equal(next.panY, -100);
  assert.equal(next.zoom, 2);
});
