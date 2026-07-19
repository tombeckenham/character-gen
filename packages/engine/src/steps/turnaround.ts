import type { FalClient } from "../fal.ts";
import { angleKind, TURNAROUND_ANGLES } from "../types.ts";
import type { AssetRecord, CharacterRecord, TurnaroundAngle } from "../types.ts";
import {
  dedupedReporter,
  ensureCharacterMediaDir,
  extractImageUrl,
  storeImage,
  withStepStatus,
} from "./common.ts";
import type { GeneratedImage, GenProgress, StepMediaDeps } from "./common.ts";

export const TURNAROUND_ENDPOINT = "fal-ai/qwen-image-edit-2511-multiple-angles";

export interface AngleGenInput {
  /** The fal-hosted URL of the master image to re-shoot from another angle. */
  imageUrl: string;
  /** Horizontal rotation around the character: 0=front, 90=right, 180=back. */
  horizontalAngle: number;
}

/** The turnaround step's only fal dependency, injectable so tests run offline. */
export interface AngleGenerator {
  angle(input: AngleGenInput, onProgress?: (update: GenProgress) => void): Promise<GeneratedImage>;
}

/**
 * Real `AngleGenerator` backed by the fal client's queue `subscribe`. Conforms
 * to the verified qwen-image-edit-2511-multiple-angles schema: required
 * `image_urls` plus `horizontal_angle`; the response carries `images`.
 */
export function makeFalAngleGenerator(client: FalClient): AngleGenerator {
  return {
    async angle(input, onProgress) {
      const result = await client.subscribe(TURNAROUND_ENDPOINT, {
        input: {
          image_urls: [input.imageUrl],
          horizontal_angle: input.horizontalAngle,
        },
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return { requestId: result.requestId, url: extractImageUrl(result.data) };
    },
  };
}

export interface RunTurnaroundDeps extends StepMediaDeps {
  generator: AngleGenerator;
  /** Angles to generate (defaults to all 8). Parameterized so tests can run a
   * cheap subset; the CLI always passes the full set. */
  angles?: readonly TurnaroundAngle[];
  /** Called after each frame is stored — the CLI refreshes the gallery here so
   * an open page shows frames arriving one by one. Must not throw. */
  onFrame?: (frame: AssetRecord) => void | Promise<void>;
}

export interface TurnaroundOutcome {
  frames: AssetRecord[];
}

/**
 * The master image the turnaround shoots from: the newest `master` asset that
 * still has a fal URL (assets are ordered oldest-first). Null when the sheet
 * step has not produced one.
 */
export async function findMasterUrl(
  db: StepMediaDeps["db"],
  characterId: string,
): Promise<string | null> {
  const assets = await db.getAssets(characterId);
  for (let i = assets.length - 1; i >= 0; i -= 1) {
    const asset = assets[i];
    if (asset && asset.kind === "master" && asset.url !== null && asset.url.length > 0) {
      return asset.url;
    }
  }
  return null;
}

/**
 * Generates the turnaround frames — one image per angle, shot from the master —
 * downloading each to `<mediaDir>/<identifier>/` and recording an asset row
 * (kind `angle_<deg>`, with the fal request id) per frame. Marks the
 * `turnaround` status running → done; on failure marks it `error` and rethrows,
 * leaving frames already produced intact. Requires a completed sheet step (a
 * master image with a fal URL).
 */
export async function runTurnaround(
  character: CharacterRecord,
  deps: RunTurnaroundDeps,
): Promise<TurnaroundOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.mediaDir, "turnaround");
  const angles = deps.angles ?? TURNAROUND_ANGLES;

  const masterUrl = await findMasterUrl(deps.db, character.id);
  if (masterUrl === null) {
    throw new Error(
      `No master image found for "${character.identifier}" — run \`character-gen sheet ${character.identifier}\` first.`,
    );
  }

  return withStepStatus(deps.db, character.id, "turnaround", report, async () => {
    const frames: AssetRecord[] = [];
    for (const angle of angles) {
      report(`angle ${angle}°: generating…`);
      // Frames are generated sequentially so progress reads cleanly and a
      // failure leaves a clean prefix of completed angles.
      // oxlint-disable-next-line no-await-in-loop
      const image = await deps.generator.angle(
        { imageUrl: masterUrl, horizontalAngle: angle },
        (update) => report(`angle ${angle}°: ${update.status.toLowerCase()}`),
      );
      // oxlint-disable-next-line no-await-in-loop
      const asset = await storeImage({
        deps,
        character,
        charDir,
        kind: angleKind(angle),
        fileName: `angle-${angle}.png`,
        image,
        meta: { endpoint: TURNAROUND_ENDPOINT, horizontalAngle: angle, sourceUrl: masterUrl },
      });
      frames.push(asset);
      // oxlint-disable-next-line no-await-in-loop
      await deps.onFrame?.(asset);
    }
    return { frames };
  });
}
