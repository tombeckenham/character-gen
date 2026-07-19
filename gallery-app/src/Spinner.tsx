import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  frameIndexFromDrag,
  reduceWheelSpin,
  TURNAROUND_ANGLES,
  wrapFrameIndex,
} from "@character-gen/engine/gallery-data";
import type { SpinnerFrame } from "@character-gen/engine/gallery-data";

interface DragState {
  pointerId: number;
  startX: number;
  startIndex: number;
}

/**
 * Drag-to-scrub pseudo-3D turnaround viewer. Every frame's <img> stays mounted
 * (only the active one visible), which preloads them all and makes scrubbing
 * flicker-free. The frame index lives in state keyed by nothing
 * data-dependent, so a live data.js refresh (frames arriving during
 * generation) re-renders around it without resetting the spin position.
 */
// One interaction surface: the drag/wheel/keyboard handlers and the frame
// stack belong to the same stage element; splitting would scatter drag state.
// oxlint-disable-next-line max-lines-per-function
export function TurnaroundSpinner({ frames, name }: { frames: SpinnerFrame[]; name: string }) {
  const [rawIndex, setRawIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Frames whose media failed to load; they drop out of the scrub set rather
  // than showing the browser's broken-image icon at that angle.
  const [brokenPaths, setBrokenPaths] = useState<ReadonlySet<string>>(new Set());
  const dragRef = useRef<DragState | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef(0);
  // Sub-threshold wheel travel carried between events (see reduceWheelSpin).
  const wheelRemainderRef = useRef(0);

  const usable = frames.filter((frame) => !brokenPaths.has(frame.path));
  // The frame list can change between renders (live poll, a frame breaking);
  // wrapping keeps the index valid without snapping back to the front.
  const index = wrapFrameIndex(rawIndex, usable.length);
  useEffect(() => {
    indexRef.current = index;
  });

  // React attaches wheel listeners passively; rotating the character must not
  // also scroll the page, so the non-passive listener is attached by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const count = usable.length;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const spin = reduceWheelSpin(
        { index: indexRef.current, accumulated: wheelRemainderRef.current },
        event.deltaY,
        count,
      );
      wheelRemainderRef.current = spin.accumulated;
      setRawIndex(spin.index);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [usable.length]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const stepFrame = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    setRawIndex(wrapFrameIndex(index + delta, usable.length));
  };

  const active = usable[index];
  if (!active) {
    return <p className="empty">Turnaround frames failed to load.</p>;
  }

  return (
    <div>
      <div
        ref={stageRef}
        className={`spinner-stage${dragging ? " spinner-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label={`${name} turnaround — drag, scroll, or use arrow keys to spin`}
        aria-valuenow={active.angle}
        aria-valuemin={usable[0]?.angle ?? 0}
        aria-valuemax={usable.at(-1)?.angle ?? 0}
        aria-valuetext={`${active.angle} degrees`}
        onKeyDown={stepFrame}
        onPointerDown={(event) => {
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startIndex: index,
          };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setRawIndex(
            frameIndexFromDrag(drag.startIndex, event.clientX - drag.startX, usable.length),
          );
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {usable.map((frame, frameIndex) => (
          <img
            key={frame.path}
            src={frame.path}
            alt={`${name} — ${frame.angle}° view`}
            draggable={false}
            onError={() =>
              setBrokenPaths((previous) =>
                previous.has(frame.path) ? previous : new Set(previous).add(frame.path),
              )
            }
            className={
              frameIndex === index ? "spinner-frame spinner-frame-active" : "spinner-frame"
            }
          />
        ))}
        <span className="spinner-angle">{active.angle}°</span>
      </div>
      <p className="spinner-hint">
        drag to spin · scroll to rotate · {usable.length}/{TURNAROUND_ANGLES.length} frame
        {usable.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
