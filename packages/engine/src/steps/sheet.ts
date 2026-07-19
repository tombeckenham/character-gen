import { buildCanonClause, buildNegativeClause } from "../canon.ts";
import type { FalClient } from "../fal.ts";
import type { AssetRecord, CharacterProfile, CharacterRecord } from "../types.ts";
import {
  dedupedReporter,
  ensureCharacterMediaDir,
  extractImageUrl,
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
}

export interface SheetOutcome {
  master: AssetRecord;
  variants: AssetRecord[];
}

/**
 * Generates the master reference image and the default derived variants for a
 * character, downloading each to `<charactersDir>/<identifier>/` and recording an
 * asset record (with the fal request id) per image. Marks the `sheet` status
 * running → done (it may re-run from a prior done/error, so it does not assume
 * "pending"). On failure, marks the step `error` and rethrows, leaving any
 * assets already produced intact.
 */
export async function runSheet(
  character: CharacterRecord,
  deps: RunSheetDeps,
): Promise<SheetOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.charactersDir, "sheet");

  return await withStepStatus(deps.store, character.id, "sheet", report, async () => {
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
      const asset = await storeAsset({
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

    return { master, variants };
  });
}
