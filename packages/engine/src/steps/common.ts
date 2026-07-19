// Shared core for media-producing pipeline steps (sheet, turnaround): the
// download/store path for generated images and the step-status bookkeeping.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidIdentifier } from "../character.ts";
import type { FetchImpl } from "../fal.ts";
import type { AssetRecord, CharacterRecord, PipelineStep } from "../types.ts";
import type { Database } from "../db/index.ts";

/** Default per-image download timeout — generous vs. falRest's 10s: a multi-MB
 * PNG fetch legitimately takes longer. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** One generated image: the fal request id (doubles as a publish reference) and
 * the fal-hosted URL to download. */
export interface GeneratedImage {
  requestId: string;
  url: string;
}

/** A queue update trimmed to what a step reports; wider than the fal client's
 * QueueStatus so any status shape is accepted. */
export interface GenProgress {
  status: string;
}

/** The dependencies every media-producing step shares. */
export interface StepMediaDeps {
  db: Database;
  /** State media root; per-character files go under `<mediaDir>/<identifier>/`. */
  mediaDir: string;
  /** Injectable downloader so tests avoid the network (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Per-image download timeout (defaults to DEFAULT_DOWNLOAD_TIMEOUT_MS). */
  downloadTimeoutMs?: number;
  /** Progress sink for queue updates and step transitions (defaults to no-op). */
  onProgress?: (message: string) => void;
}

/** Pulls the first image URL out of a fal image response, or throws. */
export function extractImageUrl(data: unknown): string {
  const images = (data as { images?: unknown }).images;
  if (Array.isArray(images) && images.length > 0) {
    const first: unknown = images[0];
    if (first !== null && typeof first === "object") {
      const url = (first as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) return url;
    }
  }
  throw new Error("fal image response contained no image URL");
}

/**
 * Wraps a step's progress sink: the fal queue fires an update on every poll, so
 * consecutive identical messages collapse and progress reads as one line per
 * state, not hundreds.
 */
export function dedupedReporter(sink?: (message: string) => void): (message: string) => void {
  const emit = sink ?? (() => {});
  let lastMessage = "";
  return (message: string): void => {
    if (message === lastMessage) return;
    lastMessage = message;
    emit(message);
  };
}

/**
 * Validates the character's identifier and ensures its media directory exists,
 * returning the directory. The identifier lands in a file path, so a malformed
 * one is refused outright (defense in depth against path traversal).
 */
export function ensureCharacterMediaDir(
  character: CharacterRecord,
  mediaDir: string,
  step: PipelineStep,
): string {
  if (!isValidIdentifier(character.identifier)) {
    throw new Error(
      `Refusing to run ${step} for an invalid identifier: "${character.identifier}".`,
    );
  }
  const charDir = join(mediaDir, character.identifier);
  mkdirSync(charDir, { recursive: true });
  return charDir;
}

/**
 * Runs `work` under the step's status lifecycle: running → done, or error on
 * failure (assets already produced stay intact). The error-status write must
 * never mask the real failure — it is reported and the original error rethrown.
 */
export async function withStepStatus<T>(
  db: Database,
  characterId: string,
  step: PipelineStep,
  report: (message: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  await db.setStepState(characterId, step, "running");
  try {
    const result = await work();
    await db.setStepState(characterId, step, "done");
    report(`${step}: done`);
    return result;
  } catch (error) {
    try {
      await db.setStepState(characterId, step, "error");
    } catch (statusError) {
      report(
        `warning: could not mark ${step} failed: ${
          statusError instanceof Error ? statusError.message : String(statusError)
        }`,
      );
    }
    throw error;
  }
}

async function downloadTo(
  url: string,
  dest: string,
  fetchImpl: FetchImpl,
  timeoutMs: number,
): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Failed to download image (HTTP ${res.status}) from ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

export interface StoreImageArgs {
  deps: StepMediaDeps;
  character: CharacterRecord;
  charDir: string;
  kind: AssetRecord["kind"];
  fileName: string;
  image: GeneratedImage;
  meta: Record<string, unknown>;
}

/**
 * Records the asset row FIRST (with the billed fal request_id), then downloads
 * the file and patches in the local path. A download failure leaves the row with
 * a null `local_path` so the request_id stays referenceable for publish/retry.
 */
export async function storeImage(args: StoreImageArgs): Promise<AssetRecord> {
  const { deps, character, charDir, kind, fileName, image, meta } = args;
  const asset = await deps.db.insertAsset({
    characterId: character.id,
    kind,
    falRequestId: image.requestId,
    url: image.url,
    localPath: null,
    meta,
  });
  const localPath = join(charDir, fileName);
  await downloadTo(
    image.url,
    localPath,
    deps.fetchImpl ?? fetch,
    deps.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  );
  return deps.db.setAssetLocalPath(asset.id, localPath);
}
