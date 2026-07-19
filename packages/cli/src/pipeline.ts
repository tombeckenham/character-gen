import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  createCharacter,
  deriveMinimalProfile,
  describeError,
  ensureStateDirs,
  IMPLEMENTED_STEPS,
  makeFalClient,
  makeFalImageGenerator,
  openDatabase,
  PIPELINE_STEPS,
  refreshGalleryIfPresent,
  resolveFalKey,
  runSheet,
  statePaths,
  validateProfile,
} from "@character-gen/engine";
import type {
  CharacterProfile,
  CharacterRecord,
  Database,
  FalClient,
  ImageGenerator,
  PipelineStep,
  StatePaths,
} from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";

// Which steps `create` implements vs. merely recognizes are both derived from the
// engine's canonical lists, so a future phase enabling a step touches one place.
const IMPLEMENTED = new Set<string>(IMPLEMENTED_STEPS);
const RECOGNIZED = new Set<string>(PIPELINE_STEPS);
const AVAILABLE_LABEL = IMPLEMENTED_STEPS.join(", ");

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

/** Splits/validates the --steps list, defaulting to the implemented steps. A
 * recognized-but-unimplemented step and an unknown step give distinct errors. */
function parseSteps(raw: string | undefined): { steps: PipelineStep[] } | { error: string } {
  if (raw === undefined) return { steps: [...IMPLEMENTED_STEPS] };
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (requested.length === 0) {
    return { error: `--steps was empty. Pass a comma-separated list like ${AVAILABLE_LABEL}.` };
  }
  const steps: PipelineStep[] = [];
  for (const step of requested) {
    if (!RECOGNIZED.has(step)) {
      return { error: `Unknown step "${step}". Available steps: ${AVAILABLE_LABEL}.` };
    }
    if (!IMPLEMENTED.has(step)) {
      return { error: `Step "${step}" is recognized but not implemented yet.` };
    }
    steps.push(step as PipelineStep);
  }
  return { steps };
}

/** Rewrites the gallery if one has ever been written (i.e. `open` was run);
 * failures only warn. */
function refreshGallery(db: Database, paths: StatePaths): Promise<void> {
  return refreshGalleryIfPresent({ db, galleryDir: paths.galleryDir, onWarn: err });
}

/** Runs the sheet step for a character, streaming progress to stderr and a
 * summary to stdout. Returns whether it succeeded. Refreshes the gallery after
 * the run either way, so an open page shows the done/error state live. */
async function runSheetAndReport(
  db: Database,
  character: CharacterRecord,
  generator: ImageGenerator,
  paths: StatePaths,
): Promise<boolean> {
  let succeeded: boolean;
  try {
    const outcome = await runSheet(character, {
      db,
      generator,
      mediaDir: paths.mediaDir,
      onProgress: (message) => err(message),
    });
    out(
      `Sheet complete for ${character.identifier}: master + ${outcome.variants.length} variants.`,
    );
    out(`  master     ${outcome.master.localPath ?? "(no path)"}`);
    for (const variant of outcome.variants) {
      out(`  ${variant.kind.padEnd(10)} ${variant.localPath ?? "(no path)"}`);
    }
    succeeded = true;
  } catch (error) {
    err(`Sheet generation failed: ${describeError(error)}`);
    succeeded = false;
  }
  await refreshGallery(db, paths);
  return succeeded;
}

/** Resolves the profile to create from --profile-json or a positional
 * description; uses the DB to make a derived identifier unique. */
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
      "--surprise is designed for the create-character skill, which rolls a profile and passes it via --profile-json. For now, pass --profile-json directly.",
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
    await refreshGallery(db, paths);

    if (runSheetStep) {
      const client = resolveClient();
      if ("error" in client) {
        err(client.error);
        return 1;
      }
      const generator = makeFalImageGenerator(client.client);
      return (await runSheetAndReport(db, character, generator, paths)) ? 0 : 1;
    }
    return 0;
  } finally {
    db.close();
  }
}

export interface SheetDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the fal-backed image generator (tests run offline). */
  generator?: ImageGenerator;
}

export async function cmdSheet(rest: string[], deps: SheetDeps = {}): Promise<number> {
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
  const paths = statePaths(deps.env ?? process.env);
  ensureStateDirs(paths, ["root", "mediaDir"]);
  const db = openDatabase(paths.dbFile);
  try {
    const character = await db.getCharacter(target);
    if (!character) {
      err(`No character found matching "${target}".`);
      return 1;
    }
    let generator = deps.generator;
    if (!generator) {
      const client = resolveClient();
      if ("error" in client) {
        err(client.error);
        return 1;
      }
      generator = makeFalImageGenerator(client.client);
    }
    return (await runSheetAndReport(db, character, generator, paths)) ? 0 : 1;
  } finally {
    db.close();
  }
}
