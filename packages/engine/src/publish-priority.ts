// Pure ordering for the publish step's `reference_images`: a full-tier
// character (sheet passes + turnaround) produces more assets than the fal
// Assets API accepts, so references are ranked by identity value and capped.
// Node-free and data-only, so it is trivially unit-testable.
import { angleFromKind } from "./types.ts";

/** The fal Assets Characters API accepts at most this many reference_images. */
export const REFERENCE_IMAGE_CAP = 20;

/** The turnaround views worth a reference slot before outfits: the cardinals. */
const CARDINAL_ANGLES: ReadonlySet<number> = new Set([0, 90, 180, 270]);

/**
 * Rank of an asset kind for publish references — lower publishes first. Faces
 * beat everything (face drift is the #1 downstream failure), then the master,
 * scale, expressions, detail macros, the four cardinal turnaround angles,
 * outfit variants, and finally the remaining angles. Unknown/non-image kinds
 * (voice, speech) rank last and only survive under-cap.
 */
export function referenceRank(kind: string): number {
  if (kind.startsWith("face_")) return 0;
  if (kind === "master") return 1;
  if (kind === "scale") return 2;
  if (kind === "expression") return 3;
  if (kind === "detail") return 4;
  const angle = angleFromKind(kind);
  if (angle !== null) return CARDINAL_ANGLES.has(angle) ? 5 : 7;
  if (kind === "outfit") return 6;
  return 8;
}

/**
 * Orders assets by referenceRank (stable within a rank — input order, i.e.
 * generation order, is preserved) and caps the result at `cap` entries.
 */
export function prioritizeReferenceAssets<T extends { kind: string }>(
  assets: readonly T[],
  cap: number = REFERENCE_IMAGE_CAP,
): T[] {
  return assets
    .map((asset, index) => ({ asset, index }))
    .toSorted(
      (a, b) => referenceRank(a.asset.kind) - referenceRank(b.asset.kind) || a.index - b.index,
    )
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.asset);
}
