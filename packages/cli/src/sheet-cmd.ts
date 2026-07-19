import { parseArgs } from "node:util";
import {
  ensureStateDirs,
  makeFalImageGenerator,
  MAX_DETAIL_MACROS,
  openStore,
  SHEET_PASSES,
  SHEET_TIERS,
  statePaths,
  TIER_DETAIL_CAP,
  TIER_PASSES,
} from "@character-gen/engine";
import type { ImageGenerator, SheetPass, SheetTier } from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";
import { resolveClient, runSheetAndReport, runSheetPassesAndReport } from "./pipeline.ts";

/** Validates a --tier value (defaulting to core). */
export function parseTier(raw: string | undefined): { tier: SheetTier } | { error: string } {
  if (raw === undefined) return { tier: "core" };
  if ((SHEET_TIERS as readonly string[]).includes(raw)) return { tier: raw as SheetTier };
  return { error: `Unknown tier "${raw}". Available tiers: ${SHEET_TIERS.join(", ")}.` };
}

/** Splits/validates a --passes list against the real pass names. */
export function parsePasses(raw: string): { passes: SheetPass[] } | { error: string } {
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (requested.length === 0) {
    return {
      error: `--passes was empty. Pass a comma-separated list like ${SHEET_PASSES.join(",")}.`,
    };
  }
  const passes: SheetPass[] = [];
  for (const pass of requested) {
    if (!(SHEET_PASSES as readonly string[]).includes(pass)) {
      return { error: `Unknown pass "${pass}". Available passes: ${SHEET_PASSES.join(", ")}.` };
    }
    passes.push(pass as SheetPass);
  }
  return { passes };
}

export interface SheetDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the fal-backed image generator (tests run offline). */
  generator?: ImageGenerator;
}

/**
 * `sheet <char>`: regenerate the core sheet — plus a tier's extra passes
 * (`--tier rich|full`), or just the named passes off the existing master
 * (`--passes face,…`). Tier passes never run off a failed core sheet, and a
 * failed pass aborts the run (the money-guard, both here and in the engine).
 */
// One linear command: parse, resolve, guard, run — splitting would scatter the
// mutually-exclusive flag handling.
// oxlint-disable-next-line max-lines-per-function
export async function cmdSheet(rest: string[], deps: SheetDeps = {}): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["sheet"] ?? "");
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: { tier: { type: "string" }, passes: { type: "string" } },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    err("Usage: character-gen sheet <id|identifier> [--tier core|rich|full] [--passes <list>]");
    return 1;
  }
  if (values["tier"] !== undefined && values["passes"] !== undefined) {
    err(
      "--tier and --passes are mutually exclusive: a tier regenerates the core sheet plus its passes; --passes reruns just the named passes.",
    );
    return 1;
  }
  // Flags are validated before any store/network work so a typo fails fast.
  const requestedPasses = values["passes"] === undefined ? null : parsePasses(values["passes"]);
  if (requestedPasses && "error" in requestedPasses) {
    err(requestedPasses.error);
    return 1;
  }
  const parsedTier = parseTier(values["tier"]);
  if ("error" in parsedTier) {
    err(parsedTier.error);
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
      generator = makeFalImageGenerator(client.client);
    }
    if (requestedPasses) {
      const ok = await runSheetPassesAndReport(
        store,
        character,
        generator,
        paths,
        requestedPasses.passes,
        MAX_DETAIL_MACROS,
      );
      return ok ? 0 : 1;
    }
    // Money-guard: a tier's passes never run off a failed core sheet.
    if (!(await runSheetAndReport(store, character, generator, paths))) return 1;
    const passes = TIER_PASSES[parsedTier.tier];
    if (passes.length === 0) return 0;
    const ok = await runSheetPassesAndReport(
      store,
      character,
      generator,
      paths,
      passes,
      TIER_DETAIL_CAP[parsedTier.tier],
    );
    return ok ? 0 : 1;
  } finally {
    store.close();
  }
}
