import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import {
  createCharacter,
  DEFAULT_CREATE_STEPS,
  deriveMinimalProfile,
  ensureStateDirs,
  IMPLEMENTED_STEPS,
  makeFalAngleGenerator,
  makeFalImageGenerator,
  makeFalVoiceGenerator,
  openDatabase,
  PIPELINE_STEPS,
  statePaths,
  validateProfile,
} from "@character-gen/engine";
import type {
  AngleGenerator,
  CharacterProfile,
  CharacterRecord,
  Database,
  ImageGenerator,
  PipelineStep,
  VoiceGenerator,
} from "@character-gen/engine";
import { TIER_DETAIL_CAP, TIER_PASSES } from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";
import {
  refreshGallery,
  resolveClient,
  runSheetAndReport,
  runSheetPassesAndReport,
  runTurnaroundAndReport,
  runVoiceAndReport,
} from "./pipeline.ts";
import { parseTier } from "./sheet-cmd.ts";

// Which steps `create` implements vs. merely recognizes are both derived from the
// engine's canonical lists, so a future phase enabling a step touches one place.
const IMPLEMENTED = new Set<string>(IMPLEMENTED_STEPS);
const RECOGNIZED = new Set<string>(PIPELINE_STEPS);
const AVAILABLE_LABEL = IMPLEMENTED_STEPS.join(", ");

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

/** Splits/validates the --steps list, defaulting to profile+sheet (turnaround is
 * implemented but opt-in). A recognized-but-unimplemented step and an unknown
 * step give distinct errors. */
function parseSteps(raw: string | undefined): { steps: PipelineStep[] } | { error: string } {
  if (raw === undefined) return { steps: [...DEFAULT_CREATE_STEPS] };
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

export interface CreateDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the fal-backed generators (tests run offline). */
  imageGenerator?: ImageGenerator;
  angleGenerator?: AngleGenerator;
  voiceGenerator?: VoiceGenerator;
}

interface CreateGenerators {
  imageGenerator: ImageGenerator;
  angleGenerator: AngleGenerator;
  voiceGenerator: VoiceGenerator;
}

/** Every step generator, from the overrides or a single resolved fal client
 * (only resolved when an override is missing), or a key error to print. */
function resolveGenerators(deps: CreateDeps): CreateGenerators | { error: string } {
  if (deps.imageGenerator && deps.angleGenerator && deps.voiceGenerator) {
    return {
      imageGenerator: deps.imageGenerator,
      angleGenerator: deps.angleGenerator,
      voiceGenerator: deps.voiceGenerator,
    };
  }
  const client = resolveClient();
  if ("error" in client) return client;
  return {
    imageGenerator: deps.imageGenerator ?? makeFalImageGenerator(client.client),
    angleGenerator: deps.angleGenerator ?? makeFalAngleGenerator(client.client),
    voiceGenerator: deps.voiceGenerator ?? makeFalVoiceGenerator(client.client),
  };
}

// Argument parsing, profile resolution, create, and the optional media steps form
// one linear command; the sub-steps are already extracted into helpers above.
// oxlint-disable-next-line max-lines-per-function
export async function cmdCreate(rest: string[], deps: CreateDeps = {}): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["create"] ?? "");
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "profile-json": { type: "string" },
      steps: { type: "string" },
      tier: { type: "string" },
      surprise: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values["surprise"]) {
    err(
      "--surprise is designed for the cast skill's surprise flow, which rolls a profile and passes it via --profile-json. For now, pass --profile-json directly.",
    );
    return 1;
  }

  const parsedSteps = parseSteps(values["steps"]);
  if ("error" in parsedSteps) {
    err(parsedSteps.error);
    return 1;
  }
  const runSheetStep = parsedSteps.steps.includes("sheet");
  const runTurnaroundStep = parsedSteps.steps.includes("turnaround");
  const runVoiceStep = parsedSteps.steps.includes("voice");

  const parsedTier = parseTier(values["tier"]);
  if ("error" in parsedTier) {
    err(parsedTier.error);
    return 1;
  }
  const tierPasses = TIER_PASSES[parsedTier.tier];
  if (tierPasses.length > 0 && !runSheetStep) {
    err(`--tier ${parsedTier.tier} needs the sheet step (its passes shoot from the master image).`);
    return 1;
  }

  const paths = statePaths(deps.env ?? process.env);
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

    if (runSheetStep || runTurnaroundStep || runVoiceStep) {
      const generators = resolveGenerators(deps);
      if ("error" in generators) {
        err(generators.error);
        return 1;
      }
      if (runSheetStep) {
        const ok = await runSheetAndReport(db, character, generators.imageGenerator, paths);
        // A failed sheet leaves nothing for the turnaround to shoot from —
        // never bill 8 angle generations off a stale (or absent) master.
        if (!ok) return 1;
      }
      if (tierPasses.length > 0) {
        // Same money-guard: a failed pass stops the run before the turnaround.
        const ok = await runSheetPassesAndReport(
          db,
          character,
          generators.imageGenerator,
          paths,
          tierPasses,
          TIER_DETAIL_CAP[parsedTier.tier],
        );
        if (!ok) return 1;
      }
      if (runTurnaroundStep) {
        const ok = await runTurnaroundAndReport(db, character, generators.angleGenerator, paths);
        if (!ok) return 1;
      }
      if (runVoiceStep) {
        // Voice reads only the profile text, so it is independent of the image
        // steps and runs off the same resolved generators.
        const ok = await runVoiceAndReport(db, character, generators.voiceGenerator, paths);
        if (!ok) return 1;
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
