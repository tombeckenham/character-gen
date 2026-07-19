// The locked textual canon: one composer that turns a profile's structured
// fields into the exact phrases every image prompt reuses (and publish later
// distills into the fal Assets description). Words and pixels must match, so
// nothing else is allowed to phrase the canon its own way. Node-free.
import { DEFAULT_EXPRESSIONS } from "./types.ts";
import type { CharacterProfile, Imperfection, PhysicalTraits } from "./types.ts";

/** fal Assets `description` limit the publish composer must stay under. */
export const PUBLISH_DESCRIPTION_MAX = 2000;

const PHYSICAL_LABELS: ReadonlyArray<[keyof PhysicalTraits, string]> = [
  ["apparentAge", "apparent age"],
  ["build", "build"],
  ["skin", "skin"],
  ["eyes", "eyes"],
  ["hair", "hair"],
  ["face", "face"],
];

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cleanList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/** The physical-traits sentence, e.g. `build: wiry; eyes: pale grey; 178 cm tall`. */
function physicalClause(physical: PhysicalTraits | undefined): string | null {
  if (!physical) return null;
  const parts: string[] = [];
  for (const [key, label] of PHYSICAL_LABELS) {
    const value = trimmed(physical[key]);
    if (value) parts.push(`${label}: ${value}`);
  }
  if (typeof physical.heightCm === "number" && Number.isFinite(physical.heightCm)) {
    parts.push(`${physical.heightCm} cm tall`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** One imperfection as prompt prose: `thin white scar on the left eyebrow`. */
export function imperfectionPhrase(imperfection: Imperfection): string {
  const what = imperfection.what.trim();
  const where = imperfection.where.trim();
  return where.length > 0 ? `${what} (${where})` : what;
}

/** The imperfections the prompts and detail macros consume: well-formed entries
 * only, in profile order. */
export function profileImperfections(profile: CharacterProfile): Imperfection[] {
  return (profile.imperfections ?? []).filter(
    (entry) => trimmed(entry?.what) !== null && trimmed(entry?.where) !== null,
  );
}

/** The character's named emotional range, or the default four. */
export function profileExpressions(profile: CharacterProfile): string[] {
  const named = cleanList(profile.expressions);
  return named.length > 0 ? named : [...DEFAULT_EXPRESSIONS];
}

/**
 * The locked canon clause injected into every image prompt: visual canon,
 * structured physical traits, imperfections (the identity anchors — models hold
 * a chipped tooth more reliably than "brown hair"), signature items, and
 * material/palette language. Empty string when the profile has none of it.
 */
export function buildCanonClause(profile: CharacterProfile): string {
  const sentences: string[] = [];
  const visualCanon = trimmed(profile.visualCanon);
  if (visualCanon) sentences.push(`Appearance to reproduce exactly: ${visualCanon}.`);
  const physical = physicalClause(profile.physical);
  if (physical) sentences.push(`Physical canon: ${physical}.`);
  const imperfections = profileImperfections(profile).map((entry) => imperfectionPhrase(entry));
  if (imperfections.length > 0) {
    sentences.push(
      `Distinctive marks, always visible, never removed or cleaned up: ${imperfections.join("; ")}.`,
    );
  }
  const items = cleanList(profile.signatureItems);
  if (items.length > 0) sentences.push(`Always carrying or wearing: ${items.join("; ")}.`);
  const materials = cleanList(profile.materials);
  if (materials.length > 0) sentences.push(`Materials: ${materials.join(", ")}.`);
  const palette = cleanList(profile.palette);
  if (palette.length > 0) sentences.push(`Color palette: ${palette.join(", ")}.`);
  return sentences.join(" ");
}

/**
 * The negative canon as prose (`Hard rules: never clean-shaven; never
 * hurries.`) for endpoints without native negative guidance — gpt-image-2 has
 * none, so this rides at the end of the positive prompt. Empty when unset.
 */
export function buildNegativeClause(profile: CharacterProfile): string {
  const rules = cleanList(profile.negativeCanon).map((rule) =>
    /^never\b/iu.test(rule) ? rule : `never ${rule}`,
  );
  return rules.length > 0 ? `Hard rules: ${rules.join("; ")}.` : "";
}

/**
 * Distills the same canon fields into the fal Assets `description` used for
 * semantic matching — one composer so the published words are the ones the
 * images were generated from. Hard-capped at PUBLISH_DESCRIPTION_MAX by
 * dropping trailing sentences (never mid-sentence truncation).
 */
export function composePublishDescription(profile: CharacterProfile): string {
  const sentences: string[] = [];
  const headline = [trimmed(profile.name), trimmed(profile.archetype)].filter(Boolean).join(", ");
  if (headline) sentences.push(`${headline}.`);
  const personality = trimmed(profile.personality);
  if (personality) sentences.push(`Personality: ${personality}.`);
  const canon = buildCanonClause(profile);
  if (canon) sentences.push(canon);
  const motion = profile.motion;
  if (motion) {
    const parts = [
      ["gait", motion.gait],
      ["posture", motion.posture],
      ["resting face", motion.restingFace],
      ["habit", motion.habit],
    ]
      .map(([label, value]) => {
        const text = trimmed(value);
        return text ? `${label}: ${text}` : null;
      })
      .filter((part): part is string => part !== null);
    if (parts.length > 0) sentences.push(`Motion: ${parts.join("; ")}.`);
  }
  const voice = trimmed(profile.voiceDescription);
  if (voice) sentences.push(`Voice: ${voice}.`);
  const negative = buildNegativeClause(profile);
  if (negative) sentences.push(negative);

  let description = "";
  for (const sentence of sentences) {
    const next = description.length > 0 ? `${description} ${sentence}` : sentence;
    if (next.length > PUBLISH_DESCRIPTION_MAX) break;
    description = next;
  }
  return description;
}
