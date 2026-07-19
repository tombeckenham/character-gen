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

/** A well-formed identifier: a lowercase slug of letters, digits, and hyphens. */
const IDENTIFIER_RE = /^[a-z0-9-]+$/u;

const MAX_IDENTIFIER_LENGTH = 64;

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
