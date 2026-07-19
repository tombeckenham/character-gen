import { emptyStatus, MAX_IDENTIFIER_LENGTH } from "./types.ts";
import type { CharacterProfile, CharacterRecord, StepState } from "./types.ts";
import { DuplicateIdentifierError } from "./store/index.ts";
import type { CharacterStore } from "./store/index.ts";

/** Optional free-form string fields on a profile; validated only for type. */
const OPTIONAL_STRING_FIELDS = [
  "archetype",
  "personality",
  "backstory",
  "visualCanon",
  "voiceDescription",
] as const;

/** Optional string-array fields on a profile; every element must be a string. */
const STRING_ARRAY_FIELDS = [
  "signatureItems",
  "palette",
  "materials",
  "expressions",
  "negativeCanon",
] as const;

/** Sub-object fields whose members are free-form strings (`physical` also
 * allows the numeric `heightCm`). */
const STRING_BAG_FIELDS = ["physical", "motion"] as const;

/** A well-formed identifier: a lowercase slug of letters, digits, and hyphens.
 * (The shared validator itself lives in types.ts — see isValidIdentifier.) */
const IDENTIFIER_RE = /^[a-z0-9-]+$/u;

/** Cap on a derived display name before it is truncated with an ellipsis. */
const MAX_DERIVED_NAME_LENGTH = 60;

/**
 * Turns arbitrary text into a lowercase hyphen slug suitable for an identifier:
 * strips diacritics, collapses non-alphanumerics to single hyphens, trims edge
 * hyphens, and caps length. May return "" for input with no slug-able chars.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, MAX_IDENTIFIER_LENGTH)
    .replaceAll(/-+$/gu, "");
}

/** Shape problems for one `imperfections` entry (see PLAN-RICH-SHEETS.md §1). */
function imperfectionProblems(entry: unknown, index: number): string[] {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`"imperfections[${index}]" must be an object.`];
  }
  const problems: string[] = [];
  const { what, where, story } = entry as Record<string, unknown>;
  if (typeof what !== "string" || what.trim().length === 0) {
    problems.push(`"imperfections[${index}].what" is required and must be a string.`);
  }
  if (typeof where !== "string" || where.trim().length === 0) {
    problems.push(`"imperfections[${index}].where" is required and must be a string.`);
  }
  if (story !== undefined && typeof story !== "string") {
    problems.push(`"imperfections[${index}].story" must be a string if present.`);
  }
  return problems;
}

/** Shape problems for the optional `voice` block (model/preset selection). The
 * values are validated against the registry at voice/speak time, not here — this
 * only enforces the object shape so a malformed block is caught at authoring. */
function voiceProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ['"voice" must be an object if present.'];
  }
  const problems: string[] = [];
  const { model, preset } = value as Record<string, unknown>;
  if (model !== undefined && typeof model !== "string") {
    problems.push('"voice.model" must be a string if present.');
  }
  if (preset !== undefined && typeof preset !== "string") {
    problems.push('"voice.preset" must be a string if present.');
  }
  return problems;
}

/** Shape problems for the optional rich-sheet fields (arrays, sub-objects,
 * imperfections). All fields are optional; only present ones are checked. */
function collectRichFieldProblems(obj: Record<string, unknown>): string[] {
  const problems: string[] = [];

  const voice = obj["voice"];
  if (voice !== undefined) problems.push(...voiceProblems(voice));

  for (const field of STRING_ARRAY_FIELDS) {
    const value = obj[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      problems.push(`"${field}" must be an array of strings if present.`);
    }
  }

  for (const field of STRING_BAG_FIELDS) {
    const value = obj[field];
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`"${field}" must be an object if present.`);
      continue;
    }
    for (const [key, member] of Object.entries(value)) {
      if (field === "physical" && key === "heightCm") {
        if (typeof member !== "number") problems.push('"physical.heightCm" must be a number.');
      } else if (typeof member !== "string") {
        problems.push(`"${field}.${key}" must be a string.`);
      }
    }
  }

  const imperfections = obj["imperfections"];
  if (imperfections !== undefined) {
    if (Array.isArray(imperfections)) {
      imperfections.forEach((entry: unknown, index) => {
        problems.push(...imperfectionProblems(entry, index));
      });
    } else {
      problems.push('"imperfections" must be an array if present.');
    }
  }

  return problems;
}

/**
 * Boundary guard for the `--profile-json` input Claude authors in the skill flow.
 * Mirrors `rowToCharacter`'s direct-check style but collects every problem so the
 * caller can show them all at once. Throws with a clear, itemized message on any
 * violation; returns the value typed as a `CharacterProfile` when it passes.
 *
 * Only `name` and `identifier` are load-bearing for the engine; the rest of the
 * profile is intentionally permissive canon the prompts consume.
 */
export function validateProfile(raw: unknown): CharacterProfile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid profile: expected a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];

  const name = obj["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    problems.push('"name" is required and must be a non-empty string.');
  }

  const identifier = obj["identifier"];
  if (typeof identifier !== "string" || identifier.length === 0) {
    problems.push('"identifier" is required and must be a non-empty string.');
  } else {
    if (identifier.length > MAX_IDENTIFIER_LENGTH) {
      problems.push(`"identifier" must be at most ${MAX_IDENTIFIER_LENGTH} characters.`);
    }
    if (!IDENTIFIER_RE.test(identifier)) {
      problems.push(
        '"identifier" must be a slug: lowercase letters, digits, and hyphens only (e.g. "isolde-keeper").',
      );
    }
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = obj[field];
    if (value !== undefined && typeof value !== "string") {
      problems.push(`"${field}" must be a string if present.`);
    }
  }

  problems.push(...collectRichFieldProblems(obj));

  if (problems.length > 0) {
    throw new Error(`Invalid profile:\n- ${problems.join("\n- ")}`);
  }
  return obj as CharacterProfile;
}

/**
 * Builds an identifier from `base` that is unique against existing characters,
 * appending `-2`, `-3`, … when taken. The stem is truncated to leave room for
 * the suffix and re-trimmed so a cut landing on a hyphen can't emit `foo--2` or
 * exceed the length cap — which also prevents the fixed-point hang when `base`
 * is already MAX_IDENTIFIER_LENGTH chars.
 */
async function uniqueIdentifier(store: CharacterStore, base: string): Promise<string> {
  if (!(await store.getCharacter(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const stem = base.slice(0, MAX_IDENTIFIER_LENGTH - marker.length).replaceAll(/-+$/gu, "");
    const candidate = `${stem}${marker}`;
    // Sequential by nature: each candidate depends on the previous lookup miss.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await store.getCharacter(candidate))) return candidate;
  }
}

/**
 * Derives a minimal, valid profile from a free-form description when Claude has
 * not supplied one: a truncated display name and a unique slug identifier. The
 * result is run through `validateProfile` so every profile — authored or
 * derived — reaches `createCharacter` through the same guard.
 */
export async function deriveMinimalProfile(
  store: CharacterStore,
  description: string,
): Promise<CharacterProfile> {
  const trimmed = description.trim();
  const name =
    trimmed.length > MAX_DERIVED_NAME_LENGTH
      ? `${trimmed.slice(0, MAX_DERIVED_NAME_LENGTH - 1).trimEnd()}…`
      : trimmed;
  const base = slugify(trimmed) || "character";
  const identifier = await uniqueIdentifier(store, base);
  return validateProfile({ name, identifier, description: trimmed });
}

/**
 * Persists a new character from an already-validated profile, marking the
 * `profile` step done (Claude authored it up front). A duplicate identifier
 * surfaces as a friendly error rather than the store's raw folder-exists error.
 */
export async function createCharacter(
  store: CharacterStore,
  profile: CharacterProfile,
): Promise<CharacterRecord> {
  const status = { ...emptyStatus(), profile: "done" as StepState };
  try {
    return await store.insertCharacter({
      identifier: profile.identifier,
      name: profile.name,
      profile,
      status,
    });
  } catch (error) {
    if (error instanceof DuplicateIdentifierError) {
      // oxlint-disable-next-line prefer-type-error -- maps a store error to a user-facing message; not a type violation
      throw new Error(
        `A character with identifier "${profile.identifier}" already exists. Choose a different identifier.`,
        { cause: error },
      );
    }
    throw error;
  }
}
