import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_PIXELS_PER_FRAME,
  frameIndexFromDrag,
  reduceWheelSpin,
  selectSpinnerFrames,
  WHEEL_DELTA_PER_FRAME,
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

test("frameIndexFromDrag treats sub-threshold travel as a dead zone in both directions", () => {
  assert.equal(frameIndexFromDrag(3, DRAG_PIXELS_PER_FRAME - 1, 8), 3);
  assert.equal(frameIndexFromDrag(3, -(DRAG_PIXELS_PER_FRAME - 1), 8), 3);
});

test("frameIndexFromDrag guards a non-positive sensitivity", () => {
  assert.equal(frameIndexFromDrag(3, 500, 8, 0), 3);
  assert.equal(frameIndexFromDrag(9, 500, 8, -5), 1);
});

test("reduceWheelSpin accumulates small trackpad deltas up to the threshold", () => {
  let spin = { index: 0, accumulated: 0 };
  spin = reduceWheelSpin(spin, 40, 8);
  assert.deepEqual(spin, { index: 0, accumulated: 40 });
  spin = reduceWheelSpin(spin, 40, 8);
  assert.deepEqual(spin, { index: 0, accumulated: 80 });
  spin = reduceWheelSpin(spin, 40, 8);
  assert.deepEqual(spin, { index: 1, accumulated: 20 });
});

test("reduceWheelSpin steps once per mouse notch and carries the remainder", () => {
  const spin = reduceWheelSpin({ index: 0, accumulated: 0 }, 120, 8);
  assert.deepEqual(spin, { index: 1, accumulated: 120 - WHEEL_DELTA_PER_FRAME });
});

test("reduceWheelSpin wraps backwards and can step multiple frames at once", () => {
  assert.deepEqual(reduceWheelSpin({ index: 0, accumulated: 0 }, -WHEEL_DELTA_PER_FRAME, 8), {
    index: 7,
    accumulated: 0,
  });
  assert.deepEqual(reduceWheelSpin({ index: 2, accumulated: 0 }, WHEEL_DELTA_PER_FRAME * 3, 8), {
    index: 5,
    accumulated: 0,
  });
});

test("reduceWheelSpin drops an opposing remainder on direction change", () => {
  const forward = reduceWheelSpin({ index: 0, accumulated: 0 }, 90, 8);
  assert.deepEqual(forward, { index: 0, accumulated: 90 });
  // Reversing: the +90 toward the next frame must not absorb the first -30.
  assert.deepEqual(reduceWheelSpin(forward, -30, 8), { index: 0, accumulated: -30 });
});

test("reduceWheelSpin is inert with no frames or a bad threshold", () => {
  assert.deepEqual(reduceWheelSpin({ index: 4, accumulated: 10 }, 500, 0), {
    index: 4,
    accumulated: 10,
  });
  assert.deepEqual(reduceWheelSpin({ index: 4, accumulated: 10 }, 500, 8, 0), {
    index: 4,
    accumulated: 10,
  });
});
