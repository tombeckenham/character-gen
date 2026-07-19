import { buildCanonClause, buildNegativeClause } from "../canon.ts";
import type { FalClient } from "../fal.ts";
import type { AssetRecord, CharacterProfile, CharacterRecord } from "../types.ts";
import {
  DEFAULT_GEN_CONCURRENCY,
  dedupedReporter,
  ensureCharacterMediaDir,
  extractImageUrl,
  mapPool,
  poolFailureError,
  storeAsset,
  withStepStatus,
} from "./common.ts";
import type { GeneratedAsset, GenProgress, StepMediaDeps } from "./common.ts";

export { DEFAULT_DOWNLOAD_TIMEOUT_MS } from "./common.ts";
export type { GeneratedAsset, GenProgress } from "./common.ts";

/** Master reference model + the edit model used for all derived variants. */
export const MASTER_ENDPOINT = "openai/gpt-image-2";
export const EDIT_ENDPOINT = "openai/gpt-image-2/edit";
/** Portrait keeps a full-body figure well-framed. */
export const MASTER_IMAGE_SIZE = "portrait_4_3";

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
  ): Promise<GeneratedAsset>;
  edit(input: ImageEditInput, onProgress?: (update: GenProgress) => void): Promise<GeneratedAsset>;
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
  const canon = buildCanonClause(profile);
  return [
    `Full-body character reference sheet of ${descriptor}.`,
    canon || (profile.personality ? `Character: ${profile.personality}.` : ""),
    "Single character centered, standing in a neutral A-pose, facing the camera, full body from head to feet in frame.",
    "Plain light-gray studio background, soft even lighting, consistent art style, sharp detail. No text, no labels, no watermark, no border.",
    buildNegativeClause(profile),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Expression-sheet edit prompt: same identity, grid of facial expressions. */
export function buildExpressionPrompt(profile: CharacterProfile): string {
  return [
    `Expression sheet for ${profile.name}: the exact same character as the reference image, with an identical face, hairstyle, and outfit.`,
    "A neat grid of head-and-shoulders portraits of this same character showing distinct facial expressions: neutral, happy, angry, sad, and surprised.",
    "Preserve the character's identity and features exactly.",
    buildCanonClause(profile),
    "Plain light-gray background, even lighting, consistent art style. No text or labels.",
    buildNegativeClause(profile),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Outfit-variant edit prompt: same identity, alternate clothing. */
export function buildOutfitPrompt(profile: CharacterProfile): string {
  const archetype = profile.archetype?.trim();
  return [
    `The exact same character as the reference image — identical face, hair, and body — shown full-length in an alternate outfit${
      archetype ? ` befitting a ${archetype}` : ""
    }.`,
    "Keep the character's identity and recognizable features unchanged; change only the clothing.",
    buildCanonClause(profile),
    "Neutral A-pose, plain light-gray background, even lighting, consistent art style. No text or watermark.",
    buildNegativeClause(profile),
  ]
    .filter(Boolean)
    .join(" ");
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

export interface RunSheetDeps extends StepMediaDeps {
  generator: ImageGenerator;
  /** Max variant generations in flight (defaults to DEFAULT_GEN_CONCURRENCY). */
  concurrency?: number;
  /** Called after each asset is stored (master, then each variant) — the CLI
   * refreshes the gallery here so the core sheet lands image by image rather than
   * all at once. Failures warn, never abort. */
  onAsset?: (asset: AssetRecord) => void | Promise<void>;
}

export interface SheetOutcome {
  master: AssetRecord;
  variants: AssetRecord[];
}

/** Fires the per-asset callback without letting a throwing sink fail the step. */
async function notifyAsset(deps: RunSheetDeps, asset: AssetRecord, report: (m: string) => void) {
  try {
    await deps.onAsset?.(asset);
  } catch (error) {
    report(
      `warning: asset notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Everything one variant-worker needs beyond the variant spec itself. */
interface VariantContext {
  deps: RunSheetDeps;
  character: CharacterRecord;
  charDir: string;
  masterUrl: string;
  report: (message: string) => void;
}

/** Generates, stores, and announces one derived sheet variant off the master. */
async function generateVariant(spec: VariantSpec, ctx: VariantContext): Promise<AssetRecord> {
  const { deps, character, charDir, masterUrl, report } = ctx;
  report(`${spec.kind}: generating…`);
  const prompt = spec.buildPrompt(character.profile);
  const image = await deps.generator.edit({ prompt, imageUrls: [masterUrl] }, (update) =>
    report(`${spec.kind}: ${update.status.toLowerCase()}`),
  );
  const asset = await storeAsset({
    deps,
    character,
    charDir,
    kind: spec.kind,
    fileName: `${spec.kind}-1.png`,
    image,
    meta: { endpoint: EDIT_ENDPOINT, prompt },
  });
  await notifyAsset(deps, asset, report);
  return asset;
}

/**
 * Generates the master reference image and the default derived variants for a
 * character, downloading each to `<mediaDir>/<identifier>/` and recording an
 * asset row (with the fal request id) per image. The master is generated first
 * (the variants edit it); the variants then fan out concurrently (bounded by
 * `concurrency`), each landing via `onAsset` as it is stored. Marks the `sheet`
 * status running → done (it may re-run from a prior done/error, so it does not
 * assume "pending"). If a variant fails the others still finish, then the step
 * is marked `error` and an aggregate error is thrown, leaving any assets already
 * produced intact.
 */
export async function runSheet(
  character: CharacterRecord,
  deps: RunSheetDeps,
): Promise<SheetOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.mediaDir, "sheet");

  return await withStepStatus(deps.db, character.id, "sheet", report, async () => {
    report("master: generating reference image…");
    const masterPrompt = buildMasterPrompt(character.profile);
    const masterImage = await deps.generator.generate(
      { prompt: masterPrompt, imageSize: MASTER_IMAGE_SIZE },
      (update) => report(`master: ${update.status.toLowerCase()}`),
    );
    const master = await storeAsset({
      deps,
      character,
      charDir,
      kind: "master",
      fileName: "master-1.png",
      image: masterImage,
      meta: { endpoint: MASTER_ENDPOINT, prompt: masterPrompt, imageSize: MASTER_IMAGE_SIZE },
    });
    await notifyAsset(deps, master, report);

    const ctx: VariantContext = { deps, character, charDir, masterUrl: masterImage.url, report };
    const { results, failures } = await mapPool(
      SHEET_VARIANTS,
      deps.concurrency ?? DEFAULT_GEN_CONCURRENCY,
      (spec) => generateVariant(spec, ctx),
    );
    const variants = results.filter((variant): variant is AssetRecord => variant !== undefined);
    if (failures.length > 0) {
      throw poolFailureError("sheet", "variants", SHEET_VARIANTS.length, failures, (index) => {
        return SHEET_VARIANTS[index]?.kind ?? `variant ${index + 1}`;
      });
    }
    return { master, variants };
  });
}
