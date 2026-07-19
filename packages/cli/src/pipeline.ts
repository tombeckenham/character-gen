import { parseArgs } from "node:util";
import {
  describeError,
  ensureStateDirs,
  makeFalAngleGenerator,
  makeFalClient,
  makeFalImageGenerator,
  openDatabase,
  refreshGalleryIfPresent,
  resolveFalKey,
  runSheet,
  runTurnaround,
  statePaths,
} from "@character-gen/engine";
import type {
  AngleGenerator,
  CharacterRecord,
  Database,
  FalClient,
  ImageGenerator,
  StatePaths,
} from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";

/** Resolves a fal client from the ambient key, or an error message to print. */
export function resolveClient(): { client: FalClient } | { error: string } {
  const key = resolveFalKey();
  if (!key.ok) {
    return {
      error:
        "No fal API key found. Run `character-gen setup`, or set FAL_KEY. See `character-gen doctor`.",
    };
  }
  return { client: makeFalClient(key.key) };
}

/** Rewrites the gallery if one has ever been written (i.e. `open` was run);
 * failures only warn. */
export function refreshGallery(db: Database, paths: StatePaths): Promise<void> {
  return refreshGalleryIfPresent({ db, galleryDir: paths.galleryDir, onWarn: err });
}

/**
 * Runs one media step and reports it: `work` streams progress to stderr and
 * returns summary lines for stdout; failures print to stderr. Refreshes the
 * gallery after the run either way, so an open page shows the done/error state
 * live. Returns whether the step succeeded.
 */
async function reportStep(
  db: Database,
  paths: StatePaths,
  label: string,
  work: () => Promise<string[]>,
): Promise<boolean> {
  let succeeded: boolean;
  try {
    for (const line of await work()) out(line);
    succeeded = true;
  } catch (error) {
    err(`${label} generation failed: ${describeError(error)}`);
    succeeded = false;
  }
  await refreshGallery(db, paths);
  return succeeded;
}

/** One summary line per produced asset: kind + local path. */
function assetLine(asset: { kind: string; localPath: string | null }): string {
  return `  ${asset.kind.padEnd(10)} ${asset.localPath ?? "(no path)"}`;
}

export function runSheetAndReport(
  db: Database,
  character: CharacterRecord,
  generator: ImageGenerator,
  paths: StatePaths,
): Promise<boolean> {
  return reportStep(db, paths, "Sheet", async () => {
    const outcome = await runSheet(character, {
      db,
      generator,
      mediaDir: paths.mediaDir,
      onProgress: err,
    });
    return [
      `Sheet complete for ${character.identifier}: master + ${outcome.variants.length} variants.`,
      ...[outcome.master, ...outcome.variants].map((asset) => assetLine(asset)),
    ];
  });
}

export function runTurnaroundAndReport(
  db: Database,
  character: CharacterRecord,
  generator: AngleGenerator,
  paths: StatePaths,
): Promise<boolean> {
  return reportStep(db, paths, "Turnaround", async () => {
    const outcome = await runTurnaround(character, {
      db,
      generator,
      mediaDir: paths.mediaDir,
      onProgress: err,
      // Per-frame refresh so an open gallery shows the spin filling in live
      // (refreshGallery never throws — failures only warn).
      onFrame: () => refreshGallery(db, paths),
    });
    return [
      `Turnaround complete for ${character.identifier}: ${outcome.frames.length} frames.`,
      ...outcome.frames.map((frame) => assetLine(frame)),
    ];
  });
}

interface StepCmdSpec<G> {
  name: "sheet" | "turnaround";
  makeGenerator: (client: FalClient) => G;
  runAndReport: (
    db: Database,
    character: CharacterRecord,
    generator: G,
    paths: StatePaths,
  ) => Promise<boolean>;
}

/** Shared shape of the single-step commands (`sheet <char>`, `turnaround
 * <char>`): resolve the character, resolve/inject the generator, run + report. */
async function cmdStep<G>(
  rest: string[],
  deps: { env?: NodeJS.ProcessEnv; generator?: G },
  spec: StepCmdSpec<G>,
): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP[spec.name] ?? "");
    return 0;
  }
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) {
    err(`Usage: character-gen ${spec.name} <id|identifier>`);
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
      generator = spec.makeGenerator(client.client);
    }
    return (await spec.runAndReport(db, character, generator, paths)) ? 0 : 1;
  } finally {
    db.close();
  }
}

export interface SheetDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the fal-backed image generator (tests run offline). */
  generator?: ImageGenerator;
}

export function cmdSheet(rest: string[], deps: SheetDeps = {}): Promise<number> {
  return cmdStep(rest, deps, {
    name: "sheet",
    makeGenerator: makeFalImageGenerator,
    runAndReport: runSheetAndReport,
  });
}

export interface TurnaroundDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the fal-backed angle generator (tests run offline). */
  generator?: AngleGenerator;
}

export function cmdTurnaround(rest: string[], deps: TurnaroundDeps = {}): Promise<number> {
  return cmdStep(rest, deps, {
    name: "turnaround",
    makeGenerator: makeFalAngleGenerator,
    runAndReport: runTurnaroundAndReport,
  });
}
