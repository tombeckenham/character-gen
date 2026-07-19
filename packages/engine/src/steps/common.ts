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

/** Default number of image generations kept in flight within one step. Bounded
 * so a step fans out to fal quickly without tripping rate limits. */
export const DEFAULT_GEN_CONCURRENCY = 4;

/** A worker rejection, tagged with the input index that produced it. */
export interface PoolFailure {
  index: number;
  reason: unknown;
}

export interface PoolOutcome<R> {
  /** Worker results in input order; a failed item's slot is `undefined`. */
  results: (R | undefined)[];
  /** Every rejection, in completion order (sort by `index` for stable output). */
  failures: PoolFailure[];
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, collecting
 * every result (in input order) and every rejection rather than failing fast —
 * one bad item never cancels its siblings. Workers pull from a shared cursor, so
 * a slow item doesn't stall the others. `concurrency` is clamped to
 * `[1, items.length]`.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PoolOutcome<R>> {
  // Sparse by index: a failed item leaves a hole, filtered out by callers while
  // successes keep their input position.
  const results: (R | undefined)[] = [];
  const failures: PoolFailure[] = [];
  let cursor = 0;
  const runner = async (): Promise<void> => {
    // No await between reading and advancing the cursor, so each index is
    // claimed by exactly one runner.
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index] as T;
      try {
        // oxlint-disable-next-line no-await-in-loop
        results[index] = await worker(item, index);
      } catch (reason) {
        failures.push({ index, reason });
      }
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => runner()));
  return { results, failures };
}

/** Builds the aggregate error thrown when a fanned-out step had failures:
 * "<step>: N of M <unit> failed — <labels>", carrying the first reason as cause. */
export function poolFailureError(
  step: string,
  unit: string,
  total: number,
  failures: PoolFailure[],
  label: (index: number) => string,
): Error {
  const detail = failures
    .toSorted((a, b) => a.index - b.index)
    .map((failure) => `${label(failure.index)} (${describeReason(failure.reason)})`)
    .join(", ");
  return new Error(`${step}: ${failures.length} of ${total} ${unit} failed — ${detail}`, {
    cause: failures[0]?.reason,
  });
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** One generated media asset (image, audio, …): the fal request id (doubles as
 * a publish reference) and the fal-hosted URL to download. */
export interface GeneratedAsset {
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
  /** Per-asset download timeout (defaults to DEFAULT_DOWNLOAD_TIMEOUT_MS). */
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

/** Pulls the `audio.url` out of a fal audio response (voice-design, speech), or
 * throws. Both endpoints return a single `audio` File, not an array. */
export function extractAudioUrl(data: unknown): string {
  const audio = (data as { audio?: unknown }).audio;
  if (audio !== null && typeof audio === "object") {
    const url = (audio as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url;
  }
  throw new Error("fal audio response contained no audio URL");
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
 * failure (assets already produced stay intact). If the error-status write
 * itself fails, that write failure is reported as a warning and the original
 * work error is rethrown — the status write must never mask the real failure.
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

export interface StoreAssetArgs {
  deps: StepMediaDeps;
  character: CharacterRecord;
  charDir: string;
  kind: AssetRecord["kind"];
  fileName: string;
  image: GeneratedAsset;
  meta: Record<string, unknown>;
}

/**
 * Records the asset row FIRST (with the billed fal request_id), then downloads
 * the file and patches in the local path. A download failure leaves the row with
 * a null `local_path` so the request_id stays referenceable for publish/retry.
 */
export async function storeAsset(args: StoreAssetArgs): Promise<AssetRecord> {
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
