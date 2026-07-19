// Pure frame-selection math for the gallery's drag-to-scrub turnaround spinner.
// Bundled into the browser build via the gallery-data subpath, so it must stay
// free of node imports.
import { angleFromKind } from "./types.ts";
import type { TurnaroundAngle } from "./types.ts";

/** Horizontal drag distance that advances the spin by one frame. */
export const DRAG_PIXELS_PER_FRAME = 40;

export interface SpinnerFrame {
  angle: TurnaroundAngle;
  path: string;
}

/**
 * The frames the spinner scrubs through: one per turnaround angle, ascending
 * (frame 0 is the lowest angle present — the front view once angle_0 exists).
 * Non-angle assets are ignored; when an angle was regenerated, the later
 * (newer — assets arrive oldest-first) entry wins. Missing intermediate angles
 * are simply absent, so the spin covers whatever exists in angle order.
 */
export function selectSpinnerFrames(
  assets: ReadonlyArray<{ kind: string; path: string }>,
): SpinnerFrame[] {
  const byAngle = new Map<TurnaroundAngle, string>();
  for (const asset of assets) {
    const angle = angleFromKind(asset.kind);
    if (angle !== null) byAngle.set(angle, asset.path);
  }
  return [...byAngle.entries()]
    .map(([angle, path]) => ({ angle, path }))
    .toSorted((a, b) => a.angle - b.angle);
}

/** Wraps any integer index into [0, count); 0 when there are no frames. */
export function wrapFrameIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/**
 * The frame to show mid-drag: the frame the drag started on, stepped once per
 * DRAG_PIXELS_PER_FRAME of horizontal travel, wrapping in both directions.
 * Dragging right (positive delta) advances to higher angles, which the
 * turnaround endpoint renders as the character turning toward screen-right —
 * so the face follows the pointer: grab-and-turn, like spinning a globe.
 * (Verified against real frames: angle_45 faces screen-right of angle_0.)
 */
export function frameIndexFromDrag(
  startIndex: number,
  deltaX: number,
  count: number,
  pixelsPerFrame: number = DRAG_PIXELS_PER_FRAME,
): number {
  if (pixelsPerFrame <= 0) return wrapFrameIndex(startIndex, count);
  const steps = Math.trunc(deltaX / pixelsPerFrame);
  return wrapFrameIndex(startIndex + steps, count);
}

/** Fraction of flick velocity retained after one second of coasting. */
export const SPIN_FRICTION_PER_SECOND = 0.15;

/** Flick velocity (px/s) below which a kinetic spin settles to a stop. */
export const MIN_SPIN_VELOCITY = 40;

/** Pointer samples older than this play no part in the flick velocity. */
export const FLICK_SAMPLE_WINDOW_MS = 120;

/** One pointer-move sample used to estimate flick velocity on release. */
export interface FlickSample {
  x: number;
  /** Milliseconds timestamp (event.timeStamp / performance.now clock). */
  t: number;
}

/**
 * The release velocity of a flick, in px/s, from the drag's recent pointer
 * samples: the mean velocity across the samples inside FLICK_SAMPLE_WINDOW_MS
 * of the newest one. Old samples are ignored so a drag that pauses before
 * release reads as a hold (velocity 0), not a flick.
 */
export function estimateFlickVelocity(samples: readonly FlickSample[]): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((sample) => last.t - sample.t <= FLICK_SAMPLE_WINDOW_MS);
  if (!first || last.t <= first.t) return 0;
  return ((last.x - first.x) / (last.t - first.t)) * 1000;
}

/** A free-spinning (post-flick) state: velocity coasts down under friction. */
export interface KineticSpin {
  index: number;
  /** Signed coast velocity in drag-pixels per second; 0 = settled. */
  velocity: number;
  /** Virtual drag travel accumulated toward the next frame step. */
  accumulated: number;
}

/**
 * Advances a kinetic spin by `dtMs`: the velocity contributes virtual drag
 * travel (stepping frames with the same grab-and-turn direction as
 * frameIndexFromDrag — positive velocity spins toward higher angles), then
 * decays exponentially. At MIN_SPIN_VELOCITY the spin settles (`velocity: 0`)
 * so the caller's animation loop has a clean stop condition.
 */
export function reduceKineticSpin(
  spin: KineticSpin,
  dtMs: number,
  count: number,
  pixelsPerFrame: number = DRAG_PIXELS_PER_FRAME,
): KineticSpin {
  if (count <= 0 || pixelsPerFrame <= 0 || spin.velocity === 0) {
    return { ...spin, velocity: 0 };
  }
  // No time elapsed — keep coasting untouched. This genuinely happens: a rAF
  // callback's timestamp is the frame's begin time, which can be earlier than
  // a performance.now() captured mid-frame when the flick started.
  if (dtMs <= 0) return spin;
  const dt = dtMs / 1000;
  const travel = spin.velocity * dt + spin.accumulated;
  const steps = Math.trunc(travel / pixelsPerFrame);
  const velocity = spin.velocity * SPIN_FRICTION_PER_SECOND ** dt;
  return {
    index: wrapFrameIndex(spin.index + steps, count),
    velocity: Math.abs(velocity) < MIN_SPIN_VELOCITY ? 0 : velocity,
    accumulated: travel - steps * pixelsPerFrame,
  };
}

/** Wheel travel that advances one frame: one mouse-wheel notch (~120), or an
 * equivalent run of the small deltas a trackpad emits. */
export const WHEEL_DELTA_PER_FRAME = 100;

export interface WheelSpin {
  index: number;
  /** Wheel delta accumulated toward the next step (|accumulated| < threshold). */
  accumulated: number;
}

/**
 * Folds one wheel event into the spin. Deltas accumulate until a full
 * `deltaPerFrame` of travel is reached, then the index steps (wrapping) and
 * the remainder carries over — trackpads emit dozens of small-delta events per
 * gesture, so stepping once per event would momentum-spin wildly. Reversing
 * scroll direction drops any opposing remainder, so a direction change
 * responds immediately.
 */
export function reduceWheelSpin(
  spin: WheelSpin,
  deltaY: number,
  count: number,
  deltaPerFrame: number = WHEEL_DELTA_PER_FRAME,
): WheelSpin {
  if (count <= 0 || deltaPerFrame <= 0) return spin;
  const carried = deltaY * spin.accumulated < 0 ? 0 : spin.accumulated;
  const total = carried + deltaY;
  const steps = Math.trunc(total / deltaPerFrame);
  return {
    index: wrapFrameIndex(spin.index + steps, count),
    accumulated: total - steps * deltaPerFrame,
  };
}
