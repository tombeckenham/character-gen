import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  frameIndexFromDrag,
  frameIndexFromWheel,
  wrapFrameIndex,
} from "@character-gen/engine/gallery-data";
import type { SpinnerFrame } from "@character-gen/engine/gallery-data";

interface DragState {
  pointerId: number;
  startX: number;
  startIndex: number;
}

/**
 * Drag-to-scrub pseudo-3D turnaround viewer. All frames render stacked (only
 * the active one visible), which preloads them and makes scrubbing flicker-free.
 * The frame index lives in state keyed by nothing data-dependent, so a live
 * data.js refresh (frames arriving during generation) re-renders around it
 * without resetting the spin position.
 */
// One interaction surface: the drag/wheel handlers and the frame stack belong
// to the same stage element; splitting them would scatter the drag state.
// oxlint-disable-next-line max-lines-per-function
export function TurnaroundSpinner({ frames, name }: { frames: SpinnerFrame[]; name: string }) {
  const [rawIndex, setRawIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // The frame list can grow mid-generation; wrap instead of clamping so the
  // position stays stable relative to the set that existed when it was chosen.
  const index = wrapFrameIndex(rawIndex, frames.length);

  // React attaches wheel listeners passively; rotating the character must not
  // also scroll the page, so the non-passive listener is attached by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setRawIndex((current) => frameIndexFromWheel(current, event.deltaY, frames.length));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [frames.length]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const active = frames[index];
  if (!active) return null;

  return (
    <div>
      <div
        ref={stageRef}
        className={`spinner-stage${dragging ? " spinner-dragging" : ""}`}
        role="slider"
        aria-label={`${name} turnaround — drag to spin`}
        aria-valuenow={active.angle}
        aria-valuemin={0}
        aria-valuemax={360}
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
            frameIndexFromDrag(drag.startIndex, event.clientX - drag.startX, frames.length),
          );
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {frames.map((frame, frameIndex) => (
          <img
            key={frame.path}
            src={frame.path}
            alt={`${name} — ${frame.angle}° view`}
            draggable={false}
            className={
              frameIndex === index ? "spinner-frame spinner-frame-active" : "spinner-frame"
            }
          />
        ))}
        <span className="spinner-angle">{active.angle}°</span>
      </div>
      <p className="spinner-hint">
        drag to spin · scroll to rotate · {frames.length}/8 frame{frames.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
