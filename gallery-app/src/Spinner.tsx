import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  estimateFlickVelocity,
  FLICK_SAMPLE_WINDOW_MS,
  frameIndexFromDrag,
  MIN_SPIN_VELOCITY,
  reduceKineticSpin,
  reduceWheelSpin,
  TURNAROUND_ANGLES,
  wrapFrameIndex,
} from "@character-gen/engine/gallery-data";
import type { FlickSample, KineticSpin, SpinnerFrame } from "@character-gen/engine/gallery-data";

interface DragState {
  pointerId: number;
  startX: number;
  startIndex: number;
  /** Recent pointer samples for the release-velocity estimate. */
  samples: FlickSample[];
}

/**
 * Drag-to-scrub pseudo-3D turnaround viewer with kinetic release: a flick
 * keeps the character spinning under exponential friction (all momentum math
 * in the engine's spinner module). Every frame's <img> stays mounted (only the
 * active one visible), which preloads them all and makes scrubbing
 * flicker-free. The frame index lives in state keyed by nothing
 * data-dependent, so a live data.js refresh (frames arriving during
 * generation) re-renders around it without resetting the spin position.
 */
// One interaction surface: the drag/wheel/keyboard handlers and the frame
// stack belong to the same stage element; splitting would scatter drag state.
// oxlint-disable-next-line max-lines-per-function -- one cohesive gesture/render unit
export function TurnaroundSpinner({
  frames,
  name,
  variant = "detail",
}: {
  frames: SpinnerFrame[];
  name: string;
  /**
   * "card" is the grid-thumbnail form: no caption or chrome, no wheel capture
   * (the grid must keep scrolling), not separately focusable (it sits inside
   * the card's Link), and a real drag swallows the click so spinning never
   * navigates.
   */
  variant?: "detail" | "card";
}) {
  const [rawIndex, setRawIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Card thumbnails auto-rotate while pointed at (see the hover effect below).
  const [hovering, setHovering] = useState(false);
  // Frames whose media failed to load; they drop out of the scrub set rather
  // than showing the browser's broken-image icon at that angle.
  const [brokenPaths, setBrokenPaths] = useState<ReadonlySet<string>>(new Set());
  const dragRef = useRef<DragState | null>(null);
  // True once the current press actually scrubbed; the following click is
  // then swallowed so a card-variant drag doesn't trigger the wrapping Link.
  const scrubbedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef(0);
  // Sub-threshold wheel travel carried between events (see reduceWheelSpin).
  const wheelRemainderRef = useRef(0);
  // The in-flight kinetic (post-flick) spin and its rAF handle.
  const kineticRef = useRef<{ spin: KineticSpin; lastT: number; raf: number } | null>(null);
  const countRef = useRef(0);

  const usable = frames.filter((frame) => !brokenPaths.has(frame.path));
  // The frame list can change between renders (live poll, a frame breaking);
  // wrapping keeps the index valid without snapping back to the front.
  const index = wrapFrameIndex(rawIndex, usable.length);
  useEffect(() => {
    indexRef.current = index;
    countRef.current = usable.length;
  });

  const stopKinetic = (): void => {
    if (kineticRef.current !== null) cancelAnimationFrame(kineticRef.current.raf);
    kineticRef.current = null;
  };
  // Stop the coast on unmount, never mid-flight state updates after unmount.
  useEffect(() => stopKinetic, []);

  const startKinetic = (velocity: number): void => {
    stopKinetic();
    const step = (now: number): void => {
      const kinetic = kineticRef.current;
      if (!kinetic) return;
      kinetic.spin = reduceKineticSpin(kinetic.spin, now - kinetic.lastT, countRef.current);
      kinetic.lastT = now;
      setRawIndex(kinetic.spin.index);
      if (kinetic.spin.velocity === 0) {
        kineticRef.current = null;
        return;
      }
      kinetic.raf = requestAnimationFrame(step);
    };
    kineticRef.current = {
      spin: { index: indexRef.current, velocity, accumulated: 0 },
      lastT: performance.now(),
      raf: requestAnimationFrame(step),
    };
  };

  // Card thumbnails have no drag/click gesture (an anchor is natively
  // draggable, so a press-drag on the wrapping Link grabbed the link/image
  // instead of spinning). Instead they auto-rotate while the pointer is over
  // them and snap back to the front view on leave.
  useEffect(() => {
    if (variant !== "card" || !hovering) return;
    if (usable.length <= 1) return;
    let raf = 0;
    let last = performance.now();
    let accumulated = 0;
    const msPerFrame = 90;
    const step = (now: number): void => {
      accumulated += now - last;
      last = now;
      while (accumulated >= msPerFrame) {
        accumulated -= msPerFrame;
        setRawIndex((previous) => previous + 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [variant, hovering, usable.length]);

  // React attaches wheel listeners passively; rotating the character must not
  // also scroll the page, so the non-passive listener is attached by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || variant === "card") return;
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
  }, [usable.length, variant]);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    // A fast release keeps spinning; a slow one just stops where it is.
    const velocity = estimateFlickVelocity(drag.samples);
    if (Math.abs(velocity) >= MIN_SPIN_VELOCITY) startKinetic(velocity);
  };

  const stepFrame = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    setRawIndex(wrapFrameIndex(index + delta, usable.length));
  };

  const active = usable[index];
  if (!active) {
    return <p className="text-muted-foreground italic">Turnaround frames failed to load.</p>;
  }

  // The detail page owns slider semantics and keyboard focus; the card
  // thumbnail must not add a focusable widget inside its Link, so it exposes
  // the stage as decoration only.
  const sliderProps =
    variant === "detail"
      ? {
          role: "slider",
          tabIndex: 0,
          "aria-label": `${name} turnaround — drag, scroll, or use arrow keys to spin`,
          "aria-valuenow": active.angle,
          "aria-valuemin": usable[0]?.angle ?? 0,
          "aria-valuemax": usable.at(-1)?.angle ?? 0,
          "aria-valuetext": `${active.angle} degrees`,
          onKeyDown: stepFrame,
        }
      : { "aria-hidden": true };

  // The detail viewer is a drag/flick/scroll surface; the card thumbnail is a
  // hover-to-spin decoration that leaves the wrapping Link's click intact.
  const interactionProps =
    variant === "detail"
      ? {
          onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
            if (!scrubbedRef.current) return;
            event.preventDefault();
            event.stopPropagation();
          },
          onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
            // Grabbing the stage catches a coasting spin.
            stopKinetic();
            scrubbedRef.current = false;
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startIndex: index,
              samples: [{ x: event.clientX, t: event.timeStamp }],
            };
            setDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (Math.abs(event.clientX - drag.startX) > 4) scrubbedRef.current = true;
            drag.samples.push({ x: event.clientX, t: event.timeStamp });
            // Only the flick window matters; keep the buffer tiny.
            while (
              drag.samples.length > 1 &&
              event.timeStamp - (drag.samples[0]?.t ?? 0) > FLICK_SAMPLE_WINDOW_MS * 2
            ) {
              drag.samples.shift();
            }
            setRawIndex(
              frameIndexFromDrag(drag.startIndex, event.clientX - drag.startX, usable.length),
            );
          },
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
        }
      : {
          onPointerEnter: () => setHovering(true),
          onPointerLeave: () => {
            setHovering(false);
            setRawIndex(0);
          },
        };

  const stage = (
    <div
      ref={stageRef}
      className={`relative aspect-3/4 w-full overflow-hidden bg-muted/20 select-none ${
        variant === "detail"
          ? `max-w-sm touch-none rounded-lg ring-1 ring-foreground/10 focus-visible:outline-2 ${
              dragging ? "cursor-grabbing" : "cursor-grab"
            }`
          : ""
      }`}
      {...sliderProps}
      {...interactionProps}
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
          className={`absolute inset-0 h-full w-full object-contain ${
            frameIndex === index ? "opacity-100" : "opacity-0"
          }`}
        />
      ))}
      <span className="absolute right-3 bottom-2 font-mono text-xs text-muted-foreground">
        {active.angle}°
      </span>
    </div>
  );

  if (variant === "card") return stage;
  return (
    <div>
      {stage}
      <p className="mt-2 text-xs text-muted-foreground">
        drag or flick to spin · scroll to rotate · {usable.length}/{TURNAROUND_ANGLES.length} frame
        {usable.length === 1 ? "" : "s"}
      </p>
    </div>
  );
}
