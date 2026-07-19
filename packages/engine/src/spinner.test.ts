import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_PIXELS_PER_FRAME,
  estimateFlickVelocity,
  FLICK_SAMPLE_WINDOW_MS,
  frameIndexFromDrag,
  MIN_SPIN_VELOCITY,
  reduceKineticSpin,
  reduceWheelSpin,
  selectSpinnerFrames,
  SPIN_FRICTION_PER_SECOND,
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

test("frameIndexFromDrag maps horizontal travel to frame steps (drag right → higher angles)", () => {
  // Below one step of travel: stay on the start frame.
  assert.equal(frameIndexFromDrag(0, DRAG_PIXELS_PER_FRAME - 1, 8), 0);
  // One step right turns the character with the pointer (higher angle — the
  // endpoint renders higher angles facing further screen-right); one step
  // left goes the other way.
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

test("estimateFlickVelocity averages recent samples and ignores stale ones", () => {
  // 100px over 100ms → 1000 px/s.
  assert.equal(
    estimateFlickVelocity([
      { x: 0, t: 1000 },
      { x: 50, t: 1050 },
      { x: 100, t: 1100 },
    ]),
    1000,
  );
  // Leftward flicks are negative.
  assert.equal(
    estimateFlickVelocity([
      { x: 100, t: 0 },
      { x: 0, t: 100 },
    ]),
    -1000,
  );
  // A drag that paused before release: the old fast samples fall outside the
  // window, and the remaining single sample cannot define a velocity.
  assert.equal(
    estimateFlickVelocity([
      { x: 0, t: 0 },
      { x: 300, t: 100 },
      { x: 300, t: 100 + FLICK_SAMPLE_WINDOW_MS + 1 },
    ]),
    0,
  );
  assert.equal(estimateFlickVelocity([]), 0);
  assert.equal(estimateFlickVelocity([{ x: 5, t: 5 }]), 0);
});

test("reduceKineticSpin steps frames with the drag's direction and carries the remainder", () => {
  const spin = { index: 0, velocity: 400, accumulated: 0 };
  // 400 px/s for 250ms = 100px = 2 frames + 20px carried.
  const next = reduceKineticSpin(spin, 250, 8);
  assert.equal(next.index, 2);
  assert.ok(Math.abs(next.accumulated - 20) < 1e-9);
  // Friction decayed the velocity but it is still above the floor.
  assert.ok(next.velocity > 0 && next.velocity < 400);
  // Negative velocity spins the other way.
  assert.equal(reduceKineticSpin({ index: 0, velocity: -400, accumulated: 0 }, 250, 8).index, 6);
});

test("reduceKineticSpin settles to velocity 0 at the floor and on guard inputs", () => {
  // One second of friction on a barely-above-floor velocity lands under it.
  const slow = reduceKineticSpin(
    { index: 3, velocity: MIN_SPIN_VELOCITY / SPIN_FRICTION_PER_SECOND / 2, accumulated: 0 },
    1000,
    8,
  );
  assert.equal(slow.velocity, 0);
  // Guards: no frames and already-settled spins settle…
  assert.equal(reduceKineticSpin({ index: 1, velocity: 500, accumulated: 0 }, 16, 0).velocity, 0);
  const settled = reduceKineticSpin({ index: 5, velocity: 0, accumulated: 7 }, 16, 8);
  assert.equal(settled.index, 5);
  assert.equal(settled.velocity, 0);
  // …but zero/negative elapsed time keeps the momentum: the first rAF tick can
  // carry a timestamp earlier than the flick's start (frame-begin clock).
  const spin = { index: 1, velocity: 500, accumulated: 3 };
  assert.deepEqual(reduceKineticSpin(spin, 0, 8), spin);
  assert.deepEqual(reduceKineticSpin(spin, -5, 8), spin);
});
