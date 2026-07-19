import { parseArgs } from "node:util";
import {
  describeError,
  ensureStateDirs,
  makeFalAngleGenerator,
  makeFalClient,
  openStore,
  refreshGalleryIfPresent,
  resolveFalKey,
  runSheet,
  runSheetPasses,
  runTurnaround,
  statePaths,
} from "@character-gen/engine";
import type {
  AngleGenerator,
  CharacterRecord,
  CharacterStore,
  FalClient,
  ImageGenerator,
  SheetPass,
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
export function refreshGallery(store: CharacterStore, paths: StatePaths): Promise<void> {
  return refreshGalleryIfPresent({ store, galleryDir: paths.galleryDir, onWarn: err });
}

/**
 * Runs one media step and reports it: `work` streams progress to stderr and
 * returns summary lines for stdout; failures print to stderr. Refreshes the
 * gallery after the run either way, so an open page shows the done/error state
 * live. Returns whether the step succeeded.
 */
async function reportStep(
  store: CharacterStore,
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
  await refreshGallery(store, paths);
  return succeeded;
}

/** One summary line per produced asset: kind + local path. */
function assetLine(asset: { kind: string; localPath: string | null }): string {
  return `  ${asset.kind.padEnd(10)} ${asset.localPath ?? "(no path)"}`;
}

/**
 * Progress sink that also refreshes the gallery once, on the first message.
 * A step's first report fires just after it marks itself `running`, so an open
 * page flips the status chip to "running" immediately instead of when the
 * step's first asset (or its end) lands. Fire-and-forget: refreshGallery never
 * throws, and the writer's atomic data.js rename makes concurrent runs safe.
 */
function progressWithLiveStart(
  store: CharacterStore,
  paths: StatePaths,
): (message: string) => void {
  let refreshed = false;
  return (message: string): void => {
    err(message);
    if (!refreshed) {
      refreshed = true;
      void refreshGallery(store, paths);
    }
  };
}

export function runSheetAndReport(
  store: CharacterStore,
  character: CharacterRecord,
  generator: ImageGenerator,
  paths: StatePaths,
): Promise<boolean> {
  return reportStep(store, paths, "Sheet", async () => {
    const outcome = await runSheet(character, {
      store,
      generator,
      charactersDir: paths.charactersDir,
      onProgress: progressWithLiveStart(store, paths),
    });
    return [
      `Sheet complete for ${character.identifier}: master + ${outcome.variants.length} variants.`,
      ...[outcome.master, ...outcome.variants].map((asset) => assetLine(asset)),
    ];
  });
}

export function runSheetPassesAndReport(
  store: CharacterStore,
  character: CharacterRecord,
  generator: ImageGenerator,
  paths: StatePaths,
  passes: readonly SheetPass[],
  detailCap: number,
): Promise<boolean> {
  return reportStep(store, paths, "Sheet passes", async () => {
    const outcome = await runSheetPasses(character, {
      store,
      generator,
      charactersDir: paths.charactersDir,
      onProgress: progressWithLiveStart(store, paths),
      passes,
      detailCap,
      // Per-asset refresh so an open gallery fills in shot by shot
      // (refreshGallery never throws — failures only warn).
      onAsset: () => refreshGallery(store, paths),
    });
    return [
      `Passes complete for ${character.identifier} (${passes.join(", ")}): ${outcome.assets.length} images.`,
      ...outcome.assets.map((asset) => assetLine(asset)),
    ];
  });
}

export function runTurnaroundAndReport(
  store: CharacterStore,
  character: CharacterRecord,
  generator: AngleGenerator,
  paths: StatePaths,
): Promise<boolean> {
  return reportStep(store, paths, "Turnaround", async () => {
    const outcome = await runTurnaround(character, {
      store,
      generator,
      charactersDir: paths.charactersDir,
      onProgress: progressWithLiveStart(store, paths),
      // Per-frame refresh so an open gallery shows the spin filling in live
      // (refreshGallery never throws — failures only warn).
      onFrame: () => refreshGallery(store, paths),
    });
    return [
      `Turnaround complete for ${character.identifier}: ${outcome.frames.length} frames.`,
      ...outcome.frames.map((frame) => assetLine(frame)),
    ];
  });
}

interface StepCmdSpec<G> {
  name: "turnaround";
  makeGenerator: (client: FalClient) => G;
  runAndReport: (
    store: CharacterStore,
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
  ensureStateDirs(paths, ["root"]);
  const store = openStore(paths.charactersDir);
  try {
    const character = await store.getCharacter(target);
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
    return (await spec.runAndReport(store, character, generator, paths)) ? 0 : 1;
  } finally {
    store.close();
  }
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
