import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidIdentifier } from "../character.ts";
import type { FalClient, FetchImpl } from "../fal.ts";
import type { AssetRecord, CharacterProfile, CharacterRecord } from "../types.ts";
import type { Database } from "../db/index.ts";

/** Master reference model + the edit model used for all derived variants. */
export const MASTER_ENDPOINT = "openai/gpt-image-2";
export const EDIT_ENDPOINT = "openai/gpt-image-2/edit";
/** Portrait keeps a full-body figure well-framed. */
export const MASTER_IMAGE_SIZE = "portrait_4_3";

/** Default per-image download timeout — generous vs. falRest's 10s: a multi-MB
 * PNG fetch legitimately takes longer. */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** One generated image: the fal request id (doubles as a publish reference) and
 * the fal-hosted URL to download. */
export interface GeneratedImage {
  requestId: string;
  url: string;
}

/** A queue update trimmed to what the step reports; wider than the fal client's
 * QueueStatus so any status shape is accepted. */
export interface GenProgress {
  status: string;
}

export interface ImageGenInput {
  prompt: string;
  imageSize?: string;
  quality?: string;
}

export interface ImageEditInput {
  prompt: string;
  imageUrls: string[];
  quality?: string;
}

/**
 * The sheet step's only fal dependency, kept injectable so tests run offline.
 * `generate` is text-to-image (master); `edit` is image-to-image (variants).
 */
export interface ImageGenerator {
  generate(
    input: ImageGenInput,
    onProgress?: (update: GenProgress) => void,
  ): Promise<GeneratedImage>;
  edit(input: ImageEditInput, onProgress?: (update: GenProgress) => void): Promise<GeneratedImage>;
}

/** Pulls the first image URL out of a gpt-image-2 response, or throws. */
function extractImageUrl(data: unknown): string {
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
 * Real `ImageGenerator` backed by the fal client's queue `subscribe`. Conforms
 * to the verified gpt-image-2 schemas: text-to-image takes `prompt` +
 * `image_size` + `quality`; edit takes required `image_urls` + `prompt`.
 */
export function makeFalImageGenerator(client: FalClient): ImageGenerator {
  return {
    async generate(input, onProgress) {
      const result = await client.subscribe(MASTER_ENDPOINT, {
        input: {
          prompt: input.prompt,
          image_size: input.imageSize ?? MASTER_IMAGE_SIZE,
          quality: input.quality ?? "high",
        },
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return { requestId: result.requestId, url: extractImageUrl(result.data) };
    },
    async edit(input, onProgress) {
      const result = await client.subscribe(EDIT_ENDPOINT, {
        input: {
          prompt: input.prompt,
          image_urls: input.imageUrls,
          quality: input.quality ?? "high",
        },
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return { requestId: result.requestId, url: extractImageUrl(result.data) };
    },
  };
}

/** Master reference-sheet prompt: full-body, neutral, identity-defining. */
export function buildMasterPrompt(profile: CharacterProfile): string {
  const descriptor = [profile.name, profile.archetype].filter(Boolean).join(", ");
  const canon = profile.visualCanon?.trim();
  return [
    `Full-body character reference sheet of ${descriptor}.`,
    canon
      ? `Appearance to reproduce exactly: ${canon}.`
      : profile.personality
        ? `Character: ${profile.personality}.`
        : "",
    "Single character centered, standing in a neutral A-pose, facing the camera, full body from head to feet in frame.",
    "Plain light-gray studio background, soft even lighting, consistent art style, sharp detail. No text, no labels, no watermark, no border.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Expression-sheet edit prompt: same identity, grid of facial expressions. */
export function buildExpressionPrompt(profile: CharacterProfile): string {
  return [
    `Expression sheet for ${profile.name}: the exact same character as the reference image, with an identical face, hairstyle, and outfit.`,
    "A neat grid of head-and-shoulders portraits of this same character showing distinct facial expressions: neutral, happy, angry, sad, and surprised.",
    "Preserve the character's identity and features exactly. Plain light-gray background, even lighting, consistent art style. No text or labels.",
  ].join(" ");
}

/** Outfit-variant edit prompt: same identity, alternate clothing. */
export function buildOutfitPrompt(profile: CharacterProfile): string {
  const archetype = profile.archetype?.trim();
  return [
    `The exact same character as the reference image — identical face, hair, and body — shown full-length in an alternate outfit${
      archetype ? ` befitting a ${archetype}` : ""
    }.`,
    "Keep the character's identity and recognizable features unchanged; change only the clothing.",
    "Neutral A-pose, plain light-gray background, even lighting, consistent art style. No text or watermark.",
  ].join(" ");
}

interface VariantSpec {
  kind: "expression" | "outfit";
  buildPrompt: (profile: CharacterProfile) => string;
}

/** Default derived variants: one expression sheet + one outfit swap. */
export const SHEET_VARIANTS: readonly VariantSpec[] = [
  { kind: "expression", buildPrompt: buildExpressionPrompt },
  { kind: "outfit", buildPrompt: buildOutfitPrompt },
];

export interface RunSheetDeps {
  db: Database;
  generator: ImageGenerator;
  /** State media root; per-character files go under `<mediaDir>/<identifier>/`. */
  mediaDir: string;
  /** Injectable downloader so tests avoid the network (defaults to global fetch). */
  fetchImpl?: FetchImpl;
  /** Per-image download timeout (defaults to DEFAULT_DOWNLOAD_TIMEOUT_MS). */
  downloadTimeoutMs?: number;
  /** Progress sink for queue updates and step transitions (defaults to no-op). */
  onProgress?: (message: string) => void;
}

export interface SheetOutcome {
  master: AssetRecord;
  variants: AssetRecord[];
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

interface StoreImageArgs {
  deps: RunSheetDeps;
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
async function storeImage(args: StoreImageArgs): Promise<AssetRecord> {
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

/**
 * Generates the master reference image and the default derived variants for a
 * character, downloading each to `<mediaDir>/<identifier>/` and recording an
 * asset row (with the fal request id) per image. Marks the `sheet` status
 * running → done (it may re-run from a prior done/error, so it does not assume
 * "pending"). On failure, marks the step `error` and rethrows, leaving any
 * assets already produced intact.
 */
// The master-then-variants flow with its status bookkeeping reads as one linear
// sequence; splitting it would scatter the try/catch that guards the step status.
// oxlint-disable-next-line max-lines-per-function
export async function runSheet(
  character: CharacterRecord,
  deps: RunSheetDeps,
): Promise<SheetOutcome> {
  // Never trust a caller-supplied identifier in a file path (defense in depth).
  if (!isValidIdentifier(character.identifier)) {
    throw new Error(`Refusing to run sheet for an invalid identifier: "${character.identifier}".`);
  }
  // The fal queue fires an update on every poll; collapse consecutive identical
  // messages so progress reads as one line per state, not hundreds.
  const sink = deps.onProgress ?? (() => {});
  let lastMessage = "";
  const report = (message: string): void => {
    if (message === lastMessage) return;
    lastMessage = message;
    sink(message);
  };
  const charDir = join(deps.mediaDir, character.identifier);
  mkdirSync(charDir, { recursive: true });

  await deps.db.setStepState(character.id, "sheet", "running");
  try {
    report("master: generating reference image…");
    const masterPrompt = buildMasterPrompt(character.profile);
    const masterImage = await deps.generator.generate(
      { prompt: masterPrompt, imageSize: MASTER_IMAGE_SIZE },
      (update) => report(`master: ${update.status.toLowerCase()}`),
    );
    const master = await storeImage({
      deps,
      character,
      charDir,
      kind: "master",
      fileName: "master-1.png",
      image: masterImage,
      meta: { endpoint: MASTER_ENDPOINT, prompt: masterPrompt, imageSize: MASTER_IMAGE_SIZE },
    });

    const variants: AssetRecord[] = [];
    for (const spec of SHEET_VARIANTS) {
      report(`${spec.kind}: generating…`);
      const prompt = spec.buildPrompt(character.profile);
      // Variants are generated sequentially so progress reads cleanly; each is an
      // independent edit of the same master, so ordering is not otherwise load-bearing.
      // oxlint-disable-next-line no-await-in-loop
      const image = await deps.generator.edit({ prompt, imageUrls: [masterImage.url] }, (update) =>
        report(`${spec.kind}: ${update.status.toLowerCase()}`),
      );
      // oxlint-disable-next-line no-await-in-loop
      const asset = await storeImage({
        deps,
        character,
        charDir,
        kind: spec.kind,
        fileName: `${spec.kind}-1.png`,
        image,
        meta: { endpoint: EDIT_ENDPOINT, prompt },
      });
      variants.push(asset);
    }

    await deps.db.setStepState(character.id, "sheet", "done");
    report("sheet: done");
    return { master, variants };
  } catch (error) {
    // The status write must never mask the real failure; report it and rethrow.
    try {
      await deps.db.setStepState(character.id, "sheet", "error");
    } catch (statusError) {
      report(
        `warning: could not mark sheet failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
    }
    throw error;
  }
}
