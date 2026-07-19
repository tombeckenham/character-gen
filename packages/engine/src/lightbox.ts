// Pure zoom/pan math for the gallery lightbox. Bundled into the browser build
// via the gallery-data subpath, so it must stay free of node imports (the
// spinner.ts precedent — logic here, wiring in the SPA).

export const LIGHTBOX_MIN_ZOOM = 1;
export const LIGHTBOX_MAX_ZOOM = 8;

/**
 * Exponential zoom rate per wheel-delta unit. One mouse notch (~100 delta)
 * scales by ~e^0.22 ≈ 1.25×; trackpads emit many small deltas that compose to
 * the same rate — the multiplicative analogue of the spinner's accumulated
 * wheel travel, with no step threshold because zoom is continuous.
 */
export const WHEEL_ZOOM_PER_DELTA = 0.0022;

export interface LightboxTransform {
  /** Magnification, clamped to [LIGHTBOX_MIN_ZOOM, LIGHTBOX_MAX_ZOOM]. */
  zoom: number;
  /** Pan offset of the image center from the viewport center, in pixels. */
  panX: number;
  panY: number;
}

export const LIGHTBOX_REST: LightboxTransform = { zoom: 1, panX: 0, panY: 0 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return LIGHTBOX_MIN_ZOOM;
  return Math.min(LIGHTBOX_MAX_ZOOM, Math.max(LIGHTBOX_MIN_ZOOM, zoom));
}

/** The multiplicative zoom factor for one wheel event (scroll up zooms in). */
export function zoomFactorFromWheel(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_ZOOM_PER_DELTA);
}

/**
 * Clamps one pan axis so the image can never be dragged fully out of view: at
 * zoom z the overflow beyond the viewport is extent·(z−1), so the center may
 * travel at most half of that in either direction. At zoom 1 this pins pan to 0.
 */
export function clampPan(pan: number, zoom: number, extent: number): number {
  if (!Number.isFinite(pan)) return 0;
  const travel = Math.max(0, (extent * (clampZoom(zoom) - 1)) / 2);
  // `|| 0` normalizes the -0 that clamping a negative pan to zero travel yields.
  return Math.min(travel, Math.max(-travel, pan)) || 0;
}

/**
 * Applies a zoom factor about a fixed point (`originX/Y`: the cursor, in pixels
 * relative to the viewport center). The image point under the cursor stays put:
 * pan' = origin − (origin − pan)·(zoom'/zoom), then both axes are re-clamped
 * against the viewport extents — so zooming out never strands the image
 * off-center, and zooming all the way out always returns to rest.
 */
export function reduceLightboxZoom(
  transform: LightboxTransform,
  factor: number,
  originX: number,
  originY: number,
  extentWidth: number,
  extentHeight: number,
): LightboxTransform {
  const zoom = clampZoom(transform.zoom * factor);
  const scale = zoom / transform.zoom;
  return {
    zoom,
    panX: clampPan(originX - (originX - transform.panX) * scale, zoom, extentWidth),
    panY: clampPan(originY - (originY - transform.panY) * scale, zoom, extentHeight),
  };
}

/** Applies a drag delta to the pan, clamped against the viewport extents. */
export function reduceLightboxPan(
  transform: LightboxTransform,
  deltaX: number,
  deltaY: number,
  extentWidth: number,
  extentHeight: number,
): LightboxTransform {
  return {
    zoom: transform.zoom,
    panX: clampPan(transform.panX + deltaX, transform.zoom, extentWidth),
    panY: clampPan(transform.panY + deltaY, transform.zoom, extentHeight),
  };
}
