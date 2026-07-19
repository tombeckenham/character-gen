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
 * The frame to show mid-drag: the frame the drag started on, advanced one step
 * per DRAG_PIXELS_PER_FRAME of horizontal travel, wrapping in both directions.
 * Dragging right (positive delta) advances to higher angles — the camera orbits
 * the way the pointer moves.
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
