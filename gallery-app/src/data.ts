import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  DATA_GLOBAL,
  POLL_INTERVAL_MS,
  reduceGalleryPoll,
} from "@character-gen/engine/gallery-data";
import type { GalleryData } from "@character-gen/engine/gallery-data";

// data.js executes `window.CHARGEN_DATA = {...}` — typed as unknown so every
// read goes through parseGalleryData/reduceGalleryPoll.
declare global {
  interface Window {
    CHARGEN_DATA?: unknown;
  }
}

/** Consecutive failed poll ticks before the page admits it has gone stale
 * (~10s at POLL_INTERVAL_MS). */
const STALE_AFTER_FAILURES = 5;

export interface GalleryState {
  data: GalleryData | null;
  /** True when polling has failed long enough that `data` may be outdated. */
  stale: boolean;
}

/**
 * Live gallery data. fetch() is blocked on file://, so this polls by injecting
 * `<script src="data.js?t=<now>">` every POLL_INTERVAL_MS and re-renders only
 * when the payload's `version` changes (reduceGalleryPoll keeps object
 * identity otherwise, so the state set is a no-op — no flicker, in-page state
 * like scroll and focus preserved). The global is cleared before each
 * injection, so after the tick settles a missing global means a failed tick —
 * whether the file was absent (error event) or present but unparseable (a
 * script parse error still fires load). A failed tick keeps the last good
 * data and retries; enough consecutive failures flip `stale` until a tick
 * succeeds again.
 */
export function useGalleryData(): GalleryState {
  const [state, setState] = useState<GalleryState>({ data: null, stale: false });
  const currentRef = useRef<GalleryData | null>(null);
  const failuresRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = (): void => {
      delete window[DATA_GLOBAL];
      const script = document.createElement("script");
      const finish = (): void => {
        // Always remove the stale tag so polling never grows the DOM.
        script.remove();
        if (cancelled) return;
        const outcome = reduceGalleryPoll(currentRef.current, window[DATA_GLOBAL]);
        failuresRef.current = outcome.valid ? 0 : failuresRef.current + 1;
        const stale = failuresRef.current >= STALE_AFTER_FAILURES;
        if (outcome.changed) currentRef.current = outcome.data;
        setState((previous) =>
          previous.data === outcome.data && previous.stale === stale
            ? previous
            : { data: outcome.data, stale },
        );
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
      };
      script.addEventListener("load", finish, { once: true });
      script.addEventListener("error", finish, { once: true });
      script.src = `data.js?t=${Date.now()}`;
      document.head.append(script);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return state;
}

/** Route components read the live state from here (provided by the root route). */
export const GalleryContext = createContext<GalleryState>({ data: null, stale: false });

export function useGallery(): GalleryState {
  return useContext(GalleryContext);
}
