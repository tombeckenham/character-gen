import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_PIXELS_PER_FRAME,
  frameIndexFromDrag,
  frameIndexFromWheel,
  selectSpinnerFrames,
  wrapFrameIndex,
} from "./spinner.ts";

test("selectSpinnerFrames keeps only angle assets, sorted ascending by angle", () => {
  const frames = selectSpinnerFrames([
    { kind: "master", path: "m.png" },
    { kind: "angle_270", path: "d.png" },
    { kind: "angle_0", path: "a.png" },
    { kind: "expression", path: "e.png" },
    { kind: "angle_45", path: "b.png" },
  ]);
  assert.deepEqual(frames, [
    { angle: 0, path: "a.png" },
    { angle: 45, path: "b.png" },
    { angle: 270, path: "d.png" },
  ]);
});

test("selectSpinnerFrames lets a regenerated (later) frame win its angle", () => {
  const frames = selectSpinnerFrames([
    { kind: "angle_90", path: "old.png" },
    { kind: "angle_90", path: "new.png" },
  ]);
  assert.deepEqual(frames, [{ angle: 90, path: "new.png" }]);
});

test("selectSpinnerFrames ignores malformed and non-canonical angle kinds", () => {
  const frames = selectSpinnerFrames([
    { kind: "angle_12", path: "x.png" },
    { kind: "angle_", path: "y.png" },
    { kind: "voice_sample", path: "z.mp3" },
  ]);
  assert.deepEqual(frames, []);
});

test("wrapFrameIndex wraps both directions and survives zero frames", () => {
  assert.equal(wrapFrameIndex(0, 8), 0);
  assert.equal(wrapFrameIndex(9, 8), 1);
  assert.equal(wrapFrameIndex(-1, 8), 7);
  assert.equal(wrapFrameIndex(-17, 8), 7);
  assert.equal(wrapFrameIndex(5, 0), 0);
});

test("frameIndexFromDrag maps horizontal travel to frame steps", () => {
  // Below one step of travel: stay on the start frame.
  assert.equal(frameIndexFromDrag(0, DRAG_PIXELS_PER_FRAME - 1, 8), 0);
  // One step right, one step left.
  assert.equal(frameIndexFromDrag(0, DRAG_PIXELS_PER_FRAME, 8), 1);
  assert.equal(frameIndexFromDrag(0, -DRAG_PIXELS_PER_FRAME, 8), 7);
  // Long drags wrap in both directions.
  assert.equal(frameIndexFromDrag(0, DRAG_PIXELS_PER_FRAME * 10, 8), 2);
  assert.equal(frameIndexFromDrag(3, -DRAG_PIXELS_PER_FRAME * 9, 8), 2);
});

test("frameIndexFromDrag honors a custom sensitivity and fewer frames", () => {
  assert.equal(frameIndexFromDrag(0, 20, 4, 10), 2);
  assert.equal(frameIndexFromDrag(1, 25, 3, 10), 0);
  assert.equal(frameIndexFromDrag(2, 0, 0), 0);
});

test("frameIndexFromWheel steps one frame per tick, wrapping", () => {
  assert.equal(frameIndexFromWheel(0, 120, 8), 1);
  assert.equal(frameIndexFromWheel(0, -3, 8), 7);
  assert.equal(frameIndexFromWheel(7, 1, 8), 0);
  assert.equal(frameIndexFromWheel(4, 0, 8), 4);
  assert.equal(frameIndexFromWheel(4, 1, 0), 0);
});
