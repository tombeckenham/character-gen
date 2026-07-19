import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  createCharacter,
  ensureStateDirs,
  makeFalClient,
  makeFalImageGenerator,
  openDatabase,
  resolveFalKey,
  runSheet,
  slugify,
  statePaths,
  validateProfile,
} from "@character-gen/engine";
import type { CharacterProfile, CharacterRecord, Database, FalClient } from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";

/** Pipeline steps `create` can run today, and those reserved for later phases. */
const AVAILABLE_STEPS = new Set(["profile", "sheet"]);
const LATER_PHASE_STEPS = new Set(["turnaround", "voice", "publish"]);
const DEFAULT_STEPS = ["profile", "sheet"];

/** Resolves a fal client from the ambient key, or an error message to print. */
function resolveClient(): { client: FalClient } | { error: string } {
  const key = resolveFalKey();
  if (!key.ok) {
    return {
      error:
        "No fal API key found. Run `character-gen setup`, or set FAL_KEY. See `character-gen doctor`.",
    };
  }
  return { client: makeFalClient(key.key) };
}

/** Reads and JSON-parses a --profile-json file, or returns an error message. */
function loadProfileJson(path: string): { data: unknown } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { error: `Could not read profile file: ${path}` };
  }
  try {
    return { data: JSON.parse(raw) };
  } catch {
    return { error: `Profile file is not valid JSON: ${path}` };
  }
}

/** Splits/validates the --steps list, defaulting to profile+sheet. Later-phase
 * steps and unknown steps each yield a distinct, friendly error. */
function parseSteps(raw: string | undefined): { steps: string[] } | { error: string } {
  if (raw === undefined) return { steps: DEFAULT_STEPS };
  const steps = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (steps.length === 0) {
    return { error: "--steps was empty. Pass a comma-separated list like profile,sheet." };
  }
  for (const step of steps) {
    if (LATER_PHASE_STEPS.has(step)) {
      return {
        error: `Step "${step}" is coming in a later phase — not available in this build yet.`,
      };
    }
    if (!AVAILABLE_STEPS.has(step)) {
      return { error: `Unknown step "${step}". Available steps: profile, sheet.` };
    }
  }
  return { steps };
}

/** Derives a minimal profile from a free-form description when no --profile-json
 * is given: a truncated name and a slugified identifier made unique against the DB. */
async function deriveMinimalProfile(db: Database, description: string): Promise<CharacterProfile> {
  const trimmed = description.trim();
  const name = trimmed.length > 60 ? `${trimmed.slice(0, 57).trimEnd()}…` : trimmed;
  const base = slugify(trimmed) || "character";
  let identifier = base;
  let suffix = 2;
  // Walk suffixes until an unused identifier is found.
  // oxlint-disable-next-line no-await-in-loop
  while (await db.getCharacter(identifier)) {
    identifier = `${base}-${suffix}`.slice(0, 64);
    suffix += 1;
  }
  return { name, identifier, description: trimmed };
}

/** Runs the sheet step for a character, streaming progress to stderr and a
 * summary to stdout. Returns whether it succeeded. */
async function runSheetAndReport(
  db: Database,
  character: CharacterRecord,
  client: FalClient,
  mediaDir: string,
): Promise<boolean> {
  const generator = makeFalImageGenerator(client);
  try {
    const outcome = await runSheet(character, {
      db,
      generator,
      mediaDir,
      onProgress: (message) => err(message),
    });
    out(
      `Sheet complete for ${character.identifier}: master + ${outcome.variants.length} variants.`,
    );
    out(`  master     ${outcome.master.localPath ?? "(no path)"}`);
    for (const variant of outcome.variants) {
      out(`  ${variant.kind.padEnd(10)} ${variant.localPath ?? "(no path)"}`);
    }
    return true;
  } catch (error) {
    err(`Sheet generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Resolves the profile to create from --profile-json or a positional
 * description, opening the DB only for the derivation path. */
async function resolveProfile(
  db: Database,
  profileJsonPath: string | undefined,
  description: string | undefined,
): Promise<{ profile: CharacterProfile } | { error: string }> {
  if (profileJsonPath !== undefined) {
    const loaded = loadProfileJson(profileJsonPath);
    if ("error" in loaded) return { error: loaded.error };
    try {
      return { profile: validateProfile(loaded.data) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!description || description.trim().length === 0) {
    return {
      error: 'Usage: character-gen create "<description>" [--profile-json <file>] [--steps <list>]',
    };
  }
  return { profile: await deriveMinimalProfile(db, description) };
}

// Argument parsing, profile resolution, create, and the optional sheet run form
// one linear command; the sub-steps are already extracted into helpers above.
// oxlint-disable-next-line max-lines-per-function
export async function cmdCreate(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["create"] ?? "");
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "profile-json": { type: "string" },
      steps: { type: "string" },
      surprise: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values["surprise"]) {
    err(
      "--surprise is handled by the create-character skill, which rolls a profile and passes it via --profile-json. Run that skill instead.",
    );
    return 1;
  }

  const parsedSteps = parseSteps(values["steps"]);
  if ("error" in parsedSteps) {
    err(parsedSteps.error);
    return 1;
  }
  const runSheetStep = parsedSteps.steps.includes("sheet");

  const paths = statePaths();
  ensureStateDirs(paths, ["root", "mediaDir"]);
  const db = openDatabase(paths.dbFile);
  try {
    const resolved = await resolveProfile(db, values["profile-json"], positionals[0]);
    if ("error" in resolved) {
      err(resolved.error);
      return 1;
    }

    let character: CharacterRecord;
    try {
      character = await createCharacter(db, resolved.profile);
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    out(`Created ${character.name} (${character.identifier}).`);

    if (runSheetStep) {
      const client = resolveClient();
      if ("error" in client) {
        err(client.error);
        return 1;
      }
      return (await runSheetAndReport(db, character, client.client, paths.mediaDir)) ? 0 : 1;
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdSheet(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["sheet"] ?? "");
    return 0;
  }
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) {
    err("Usage: character-gen sheet <id|identifier>");
    return 1;
  }
  const paths = statePaths();
  ensureStateDirs(paths, ["root", "mediaDir"]);
  const db = openDatabase(paths.dbFile);
  try {
    const character = await db.getCharacter(target);
    if (!character) {
      err(`No character found matching "${target}".`);
      return 1;
    }
    const client = resolveClient();
    if ("error" in client) {
      err(client.error);
      return 1;
    }
    return (await runSheetAndReport(db, character, client.client, paths.mediaDir)) ? 0 : 1;
  } finally {
    db.close();
  }
}
