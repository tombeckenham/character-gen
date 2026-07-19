// The rich-sheet generation passes (face, expressions, details, scale): each an
// edit of the master image with the locked canon injected, all rolling up into
// the existing `sheet` pipeline step. Faces before outfits — face drift is the
// #1 consistency failure downstream, so the triptych leads the canonical order.
import {
  buildCanonClause,
  buildNegativeClause,
  imperfectionPhrase,
  profileExpressions,
  profileImperfections,
} from "../canon.ts";
import { MAX_DETAIL_MACROS, SHEET_PASSES } from "../types.ts";
import type {
  AssetKind,
  AssetRecord,
  CharacterProfile,
  CharacterRecord,
  FaceKind,
  SheetPass,
} from "../types.ts";
import { findMasterUrl } from "./turnaround.ts";
import { EDIT_ENDPOINT } from "./sheet.ts";
import type { ImageGenerator } from "./sheet.ts";
import {
  DEFAULT_GEN_CONCURRENCY,
  dedupedReporter,
  ensureCharacterMediaDir,
  mapPool,
  poolFailureError,
  storeAsset,
  withStepStatus,
} from "./common.ts";
import type { StepMediaDeps } from "./common.ts";

const IDENTITY_PREAMBLE =
  "The exact same character as the reference image — identical face, features, hair, and coloring.";

const STUDIO_STYLE =
  "Plain light-gray studio background, soft even lighting, consistent art style, sharp detail. No text, no labels, no watermark.";

/** Camera direction per face view. */
const FACE_VIEWS: ReadonlyArray<{ kind: FaceKind; label: string; camera: string }> = [
  { kind: "face_front", label: "front", camera: "facing the camera straight on" },
  { kind: "face_three_quarter", label: "three-quarter", camera: "turned to a three-quarter view" },
  { kind: "face_profile", label: "profile", camera: "in exact side profile" },
];

function withCanon(profile: CharacterProfile, ...body: string[]): string {
  return [
    IDENTITY_PREAMBLE,
    ...body,
    buildCanonClause(profile),
    STUDIO_STYLE,
    buildNegativeClause(profile),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Face-triptych edit prompt: neutral close-up at the given view. */
export function buildFacePrompt(profile: CharacterProfile, view: FaceKind): string {
  const spec = FACE_VIEWS.find((entry) => entry.kind === view);
  if (!spec) throw new Error(`unknown face view: ${view}`);
  return withCanon(
    profile,
    `A tightly framed head-and-shoulders studio portrait, ${spec.camera}, neutral expression, eyes open.`,
    "Every facial feature rendered exactly as in the reference — this is a face reference for identity matching.",
  );
}

/** Named-expression edit prompt (one portrait per expression, not a grid). */
export function buildNamedExpressionPrompt(profile: CharacterProfile, expression: string): string {
  return withCanon(
    profile,
    `A head-and-shoulders portrait showing one single emotion: ${expression}.`,
    "The emotion should read clearly in the face while every identifying feature stays exactly as in the reference.",
  );
}

/** What one detail macro shoots: `hands`, `imperfection:<n>`, or `prop:<n>`. */
export interface DetailSubject {
  /** Stable machine id stored in `meta.subject`. */
  subject: string;
  /** Gallery caption — the imperfection story when there is one. */
  caption: string;
  /** The macro's prompt body. */
  body: string;
}

/**
 * The detail-macro shot list, in priority order: hands first (the second most
 * identity-bearing surface after the face), then one macro per imperfection
 * (its story is the caption), then one per signature item — capped at `cap`.
 */
export function selectDetailSubjects(profile: CharacterProfile, cap: number): DetailSubject[] {
  const subjects: DetailSubject[] = [
    {
      subject: "hands",
      caption: "hands",
      body: "A macro close-up of the character's hands, resting naturally, both hands fully in frame, skin texture and any marks rendered exactly.",
    },
  ];
  profileImperfections(profile).forEach((imperfection, index) => {
    subjects.push({
      subject: `imperfection:${index}`,
      caption: imperfection.story?.trim() || imperfectionPhrase(imperfection),
      body: `A macro close-up of this exact detail on the character: ${imperfectionPhrase(imperfection)}. Fill the frame with it; render it precisely as it appears in the reference.`,
    });
  });
  (profile.signatureItems ?? []).forEach((item, index) => {
    const trimmed = item.trim();
    if (trimmed.length === 0) return;
    subjects.push({
      subject: `prop:${index}`,
      caption: trimmed,
      body: `A macro close-up of the character's ${trimmed}, worn or held as they always carry it, every material and wear mark rendered exactly.`,
    });
  });
  return subjects.slice(0, Math.max(0, cap));
}

/** Detail-macro edit prompt for one subject. */
export function buildDetailPrompt(profile: CharacterProfile, subject: DetailSubject): string {
  return withCanon(profile, subject.body);
}

/** Scale-reference edit prompt: full-body neutral A-pose with height context. */
export function buildScalePrompt(profile: CharacterProfile): string {
  const height = profile.physical?.heightCm;
  return withCanon(
    profile,
    `A full-body scale reference: the character standing in a neutral A-pose, facing the camera, full body head to feet in frame${
      typeof height === "number" && Number.isFinite(height)
        ? `, true to their height of ${height} cm`
        : ""
    }.`,
  );
}

export interface RunSheetPassesDeps extends StepMediaDeps {
  generator: ImageGenerator;
  /** Which passes to run, in any order — executed in canonical SHEET_PASSES
   * order regardless. */
  passes: readonly SheetPass[];
  /** Detail-macro budget for the `details` pass (tier-dependent). */
  detailCap?: number;
  /** Max shot generations in flight (defaults to DEFAULT_GEN_CONCURRENCY). */
  concurrency?: number;
  /** Called after each asset is stored — the CLI refreshes the gallery here so
   * an open page fills in shot by shot as each lands. Failures warn, never abort. */
  onAsset?: (asset: AssetRecord) => void | Promise<void>;
}

export interface SheetPassesOutcome {
  assets: AssetRecord[];
}

/** One image to generate: its asset kind, file name, prompt, and meta. */
interface ShotSpec {
  kind: AssetKind;
  fileName: string;
  prompt: string;
  meta: Record<string, unknown>;
}

/** Expands one pass into its concrete shots for this profile. */
function passShots(pass: SheetPass, profile: CharacterProfile, detailCap: number): ShotSpec[] {
  switch (pass) {
    case "face":
      return FACE_VIEWS.map((view) => ({
        kind: view.kind,
        fileName: `${view.kind}-1.png`,
        prompt: buildFacePrompt(profile, view.kind),
        meta: { pass, view: view.label },
      }));
    case "expressions":
      return profileExpressions(profile).map((label, index) => ({
        kind: "expression",
        fileName: `expression-${slugForFile(label, index)}.png`,
        prompt: buildNamedExpressionPrompt(profile, label),
        meta: { pass, label },
      }));
    case "details":
      return selectDetailSubjects(profile, detailCap).map((subject, index) => ({
        kind: "detail",
        fileName: `detail-${slugForFile(subject.subject, index)}.png`,
        prompt: buildDetailPrompt(profile, subject),
        meta: { pass, subject: subject.subject, caption: subject.caption },
      }));
    case "scale":
      return [
        {
          kind: "scale",
          fileName: "scale-1.png",
          prompt: buildScalePrompt(profile),
          meta: { pass },
        },
      ];
    default:
      return pass satisfies never;
  }
}

/** A filename-safe slug for a shot label, unique via its index. */
function slugForFile(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 24);
  return slug.length > 0 ? `${slug}-${index + 1}` : String(index + 1);
}

/** One shot flattened out of its pass, with a display label for progress. */
interface FlatShot {
  label: string;
  shot: ShotSpec;
}

/** Flattens the requested passes (in canonical order) into a single shot list —
 * every shot is an independent edit of the master, so they fan out together. */
function flattenShots(
  passes: readonly SheetPass[],
  profile: CharacterProfile,
  detailCap: number,
): FlatShot[] {
  const flat: FlatShot[] = [];
  for (const pass of passes) {
    const shots = passShots(pass, profile, detailCap);
    shots.forEach((shot, index) => {
      flat.push({ label: `${pass} ${index + 1}/${shots.length}`, shot });
    });
  }
  return flat;
}

/** Everything one shot-worker needs beyond the shot itself. */
interface ShotContext {
  deps: RunSheetPassesDeps;
  character: CharacterRecord;
  charDir: string;
  masterUrl: string;
  report: (message: string) => void;
}

/** Generates, stores, and announces one pass shot as an edit of the master. */
async function generateShot(flat: FlatShot, ctx: ShotContext): Promise<AssetRecord> {
  const { deps, character, charDir, masterUrl, report } = ctx;
  const { label, shot } = flat;
  report(`${label}: generating…`);
  const image = await deps.generator.edit(
    { prompt: shot.prompt, imageUrls: [masterUrl] },
    (update) => report(`${label}: ${update.status.toLowerCase()}`),
  );
  const asset = await storeAsset({
    deps,
    character,
    charDir,
    kind: shot.kind,
    fileName: shot.fileName,
    image,
    meta: { endpoint: EDIT_ENDPOINT, prompt: shot.prompt, sourceUrl: masterUrl, ...shot.meta },
  });
  try {
    await deps.onAsset?.(asset);
  } catch (error) {
    // The shot is billed and stored; a throwing notification sink must not turn
    // that into a failed pass.
    report(
      `warning: asset notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return asset;
}

/**
 * Runs the requested rich-sheet passes, each shot an edit of the master image,
 * storing every asset (kind + meta.label/subject) under the `sheet` status
 * step. Shots across all passes fan out concurrently (bounded by `concurrency`),
 * each landing via `onAsset` as it is stored. If any shot fails the others still
 * finish, then the step is marked `error` and an aggregate error is thrown, with
 * the assets that did land intact (a re-run regenerates them). Requires a
 * completed core sheet (a master with a fal URL).
 */
export async function runSheetPasses(
  character: CharacterRecord,
  deps: RunSheetPassesDeps,
): Promise<SheetPassesOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.store, "sheet");
  const passes = SHEET_PASSES.filter((pass) => deps.passes.includes(pass));
  const detailCap = deps.detailCap ?? MAX_DETAIL_MACROS;

  const masterUrl = await findMasterUrl(deps.store, character.id);
  if (masterUrl === null) {
    throw new Error(
      `No master image found for "${character.identifier}" — run \`character-gen sheet ${character.identifier}\` first.`,
    );
  }

  return withStepStatus(deps.store, character.id, "sheet", report, async () => {
    const flat = flattenShots(passes, character.profile, detailCap);
    const ctx: ShotContext = { deps, character, charDir, masterUrl, report };
    const { results, failures } = await mapPool(
      flat,
      deps.concurrency ?? DEFAULT_GEN_CONCURRENCY,
      (shot) => generateShot(shot, ctx),
    );
    const produced = results.filter((asset): asset is AssetRecord => asset !== undefined);
    if (failures.length > 0) {
      throw poolFailureError("sheet passes", "shots", flat.length, failures, (index) => {
        return flat[index]?.label ?? `shot ${index + 1}`;
      });
    }
    return { assets: produced };
  });
}
