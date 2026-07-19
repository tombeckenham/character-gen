import { emptyStatus } from "./types.ts";
import type { CharacterProfile, CharacterRecord, StepState } from "./types.ts";
import type { Database } from "./db/index.ts";

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

/** A well-formed identifier: a lowercase slug of letters, digits, and hyphens. */
const IDENTIFIER_RE = /^[a-z0-9-]+$/u;

const MAX_IDENTIFIER_LENGTH = 64;

/** Cap on a derived display name before it is truncated with an ellipsis. */
const MAX_DERIVED_NAME_LENGTH = 60;

/**
 * True when `identifier` is a well-formed slug the engine will trust in a file
 * path: non-empty, within the length cap, and only `[a-z0-9-]`. Notably rejects
 * `/`, `.`, and `..`, so it doubles as a path-traversal guard.
 */
export function isValidIdentifier(identifier: string): boolean {
  return (
    identifier.length > 0 &&
    identifier.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_RE.test(identifier)
  );
}

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

/** Shape problems for the optional rich-sheet fields (arrays, sub-objects,
 * imperfections). All fields are optional; only present ones are checked. */
function collectRichFieldProblems(obj: Record<string, unknown>): string[] {
  const problems: string[] = [];

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
 * True when `err` (or anything in its `cause` chain) is a SQLite UNIQUE
 * constraint failure. Drizzle wraps the driver error, putting the real
 * "UNIQUE constraint failed" text on `cause` — see db/index.test.ts.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if (/UNIQUE constraint failed/iu.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Builds an identifier from `base` that is unique against existing characters,
 * appending `-2`, `-3`, … when taken. The stem is truncated to leave room for
 * the suffix and re-trimmed so a cut landing on a hyphen can't emit `foo--2` or
 * exceed the length cap — which also prevents the fixed-point hang when `base`
 * is already MAX_IDENTIFIER_LENGTH chars.
 */
async function uniqueIdentifier(db: Database, base: string): Promise<string> {
  if (!(await db.getCharacter(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const stem = base.slice(0, MAX_IDENTIFIER_LENGTH - marker.length).replaceAll(/-+$/gu, "");
    const candidate = `${stem}${marker}`;
    // Sequential by nature: each candidate depends on the previous lookup miss.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await db.getCharacter(candidate))) return candidate;
  }
}

/**
 * Derives a minimal, valid profile from a free-form description when Claude has
 * not supplied one: a truncated display name and a unique slug identifier. The
 * result is run through `validateProfile` so every profile — authored or
 * derived — reaches `createCharacter` through the same guard.
 */
export async function deriveMinimalProfile(
  db: Database,
  description: string,
): Promise<CharacterProfile> {
  const trimmed = description.trim();
  const name =
    trimmed.length > MAX_DERIVED_NAME_LENGTH
      ? `${trimmed.slice(0, MAX_DERIVED_NAME_LENGTH - 1).trimEnd()}…`
      : trimmed;
  const base = slugify(trimmed) || "character";
  const identifier = await uniqueIdentifier(db, base);
  return validateProfile({ name, identifier, description: trimmed });
}

/**
 * Persists a new character from an already-validated profile, marking the
 * `profile` step done (Claude authored it up front). A duplicate identifier
 * surfaces as a friendly error rather than the raw SQLITE_CONSTRAINT.
 */
export async function createCharacter(
  db: Database,
  profile: CharacterProfile,
): Promise<CharacterRecord> {
  const status = { ...emptyStatus(), profile: "done" as StepState };
  try {
    return await db.insertCharacter({
      identifier: profile.identifier,
      name: profile.name,
      profile,
      status,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error(
        `A character with identifier "${profile.identifier}" already exists. Choose a different identifier.`,
        { cause: error },
      );
    }
    throw error;
  }
}
