import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  LIGHTBOX_REST,
  reduceLightboxPan,
  reduceLightboxZoom,
  wrapFrameIndex,
  zoomFactorFromWheel,
} from "@character-gen/engine/gallery-data";
import type { LightboxTransform } from "@character-gen/engine/gallery-data";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export interface LightboxImage {
  path: string;
  title: string;
  caption?: string | undefined;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** True once this press moved far enough to count as a drag, not a click. */
  moved: boolean;
}

/**
 * Fullscreen image lightbox: scroll/pinch-wheel to zoom about the cursor, drag
 * to pan, arrow keys / buttons to move between the character's images, Esc or a
 * click on the empty space around the image to leave. All transform math is
 * the engine's pure lightbox module; this component only wires events to it.
 */
// One interaction surface: wheel/drag/keyboard all mutate the same transform
// on the same stage element — splitting would scatter that shared state.
// oxlint-disable-next-line max-lines-per-function -- one cohesive gesture/render unit
export function Lightbox({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const [transform, setTransform] = useState<LightboxTransform>(LIGHTBOX_REST);
  // State (not a ref) so the wheel effect re-runs when the node appears — the
  // dialog portal can mount its children after this component's effects run.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  });

  const safeIndex = wrapFrameIndex(index, images.length);
  const active = images[safeIndex];

  // Switching images resets the zoom — a pan on one image is meaningless on
  // the next.
  const activePath = active?.path;
  useEffect(() => {
    setTransform(LIGHTBOX_REST);
  }, [activePath]);

  // React attaches wheel listeners passively; zooming must not also scroll the
  // page behind the overlay, so the non-passive listener is attached by hand
  // (same pattern as the turnaround spinner).
  useEffect(() => {
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      setTransform(
        reduceLightboxZoom(
          transformRef.current,
          zoomFactorFromWheel(event.deltaY),
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
          rect.width,
          rect.height,
        ),
      );
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [stage]);

  const navigate = (delta: number): void => {
    onNavigate(wrapFrameIndex(safeIndex + delta, images.length));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    navigate(event.key === "ArrowRight" ? 1 : -1);
  };

  // The press that ends this frame; read by onClick to tell a click (close)
  // from the tail of a pan (keep open).
  const lastDragMovedRef = useRef(false);
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    lastDragMovedRef.current = dragRef.current.moved;
    dragRef.current = null;
  };

  if (!active) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none bg-transparent p-0 ring-0 sm:max-w-none"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">{active.title}</DialogTitle>
        <div
          ref={setStage}
          className={`flex h-full w-full touch-none items-center justify-center overflow-hidden select-none ${
            transform.zoom > 1 ? "cursor-grab" : "cursor-zoom-in"
          }`}
          onPointerDown={(event) => {
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              lastX: event.clientX,
              lastY: event.clientY,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (
              Math.abs(event.clientX - drag.startX) > 4 ||
              Math.abs(event.clientY - drag.startY) > 4
            )
              drag.moved = true;
            const rect = event.currentTarget.getBoundingClientRect();
            setTransform(
              reduceLightboxPan(
                transformRef.current,
                event.clientX - drag.lastX,
                event.clientY - drag.lastY,
                rect.width,
                rect.height,
              ),
            );
            drag.lastX = event.clientX;
            drag.lastY = event.clientY;
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(event) => {
            // Click the empty space around the image to dismiss — but not the
            // image itself, and not the release of a pan gesture.
            if (event.target === event.currentTarget && !lastDragMovedRef.current) onClose();
          }}
        >
          <img
            src={active.path}
            alt={active.title}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            style={{
              transform: `translate(${transform.panX}px, ${transform.panY}px) scale(${transform.zoom})`,
            }}
          />
        </div>

        {images.length > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1/2 left-2 -translate-y-1/2"
              aria-label="Previous image"
              onClick={() => navigate(-1)}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-1/2 right-2 -translate-y-1/2"
              aria-label="Next image"
              onClick={() => navigate(1)}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
            </Button>
          </>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-6 pt-10 pb-4 text-center">
          <p className="m-0 text-sm text-white/90">{active.caption ?? active.title}</p>
          <p className="m-0 font-mono text-xs text-white/50">
            {safeIndex + 1} / {images.length}
            {transform.zoom > 1.01 ? ` · ${transform.zoom.toFixed(1)}×` : ""}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
