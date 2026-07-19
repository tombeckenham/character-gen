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

/**
 * Live gallery data. fetch() is blocked on file://, so this polls by injecting
 * `<script src="data.js?t=<now>">` every 2s and re-renders only when the
 * payload's `version` changes (reduceGalleryPoll keeps object identity
 * otherwise, so React bails out of unchanged renders — no flicker, scroll and
 * drag state preserved). A load error (file mid-write or not yet written) just
 * retries on the next tick.
 */
export function useGalleryData(): GalleryData | null {
  const [data, setData] = useState<GalleryData | null>(null);
  const currentRef = useRef<GalleryData | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = (): void => {
      const script = document.createElement("script");
      const finish = (): void => {
        // Always remove the stale tag so polling never grows the DOM.
        script.remove();
        if (cancelled) return;
        const outcome = reduceGalleryPoll(currentRef.current, window[DATA_GLOBAL]);
        if (outcome.changed) {
          currentRef.current = outcome.data;
          setData(outcome.data);
        }
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

  return data;
}

/** Route components read the live data from here (provided by the root route). */
export const GalleryContext = createContext<GalleryData | null>(null);

export function useGallery(): GalleryData | null {
  return useContext(GalleryContext);
}
