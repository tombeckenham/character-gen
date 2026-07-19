import { parseArgs } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import {
  ensureStateDirs,
  openDatabase,
  runDoctor,
  statePaths,
  storeValidatedKey,
} from "@character-gen/engine";
import { COMMAND_HELP, ROOT_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";
import { cmdCreate, cmdSheet } from "./pipeline.ts";
import { cmdOpen } from "./open.ts";

/** Pipeline commands that are recognized but not built yet. */
const STUBS = new Set(["turnaround", "voice", "speak", "publish", "extract"]);

/** Resolves the fal key for `setup` from --api-key or an interactive prompt.
 * Returns the key, or an error message for the caller to print. */
async function acquireApiKey(rest: string[]): Promise<{ key: string } | { error: string }> {
  const { values } = parseArgs({
    args: rest,
    options: { "api-key": { type: "string" } },
    allowPositionals: false,
  });

  const apiKeyFlag = values["api-key"];
  // An explicit-but-empty --api-key is an error, not a cue to prompt: falling
  // into the interactive readline would hang in a non-TTY (CI/agent) context.
  if (apiKeyFlag !== undefined && apiKeyFlag.trim().length === 0) {
    return { error: "--api-key was empty. Pass a key, or omit the flag to be prompted." };
  }

  let key = apiKeyFlag?.trim();
  if (key === undefined) {
    if (!input.isTTY) {
      return { error: "No API key provided. Pass --api-key <key> (stdin is not a TTY)." };
    }
    const rl = readline.createInterface({ input, output });
    key = (await rl.question("Enter your fal API key: ")).trim();
    rl.close();
  }
  if (!key) return { error: "No API key provided." };
  return { key };
}

async function cmdSetup(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["setup"] ?? "");
    return 0;
  }

  const acquired = await acquireApiKey(rest);
  if ("error" in acquired) {
    err(acquired.error);
    return 1;
  }

  out("Validating key against fal…");
  const paths = statePaths();
  const result = await storeValidatedKey({ key: acquired.key, configFile: paths.configFile });
  if (!result.stored) {
    err(
      `fal rejected the key (${result.ping.status ?? "unknown"}). Not saved — check it and retry.`,
    );
    return 1;
  }
  if (result.verified) {
    out(`Key validated and saved to ${result.configFile} (mode 0600).`);
  } else {
    const why = result.ping.status ?? result.ping.error ?? "unknown";
    out(
      `Could not verify key (${why}) — saved to ${result.configFile} anyway. Run \`character-gen doctor\` once online.`,
    );
  }
  return 0;
}

async function cmdDoctor(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["doctor"] ?? "");
    return 0;
  }
  const report = await runDoctor();
  out(`node:      ${report.nodeVersion} ${report.nodeOk ? "ok" : "TOO OLD (need >= 22.13)"}`);
  out(`key:       ${report.keySource ? `resolved (source: ${report.keySource})` : "none found"}`);
  if (report.ping) {
    const detail = report.ping.ok
      ? `ok (${report.ping.status}) via ${report.ping.endpoint}`
      : `FAILED (${report.ping.status ?? report.ping.error ?? "unknown"}) via ${report.ping.endpoint ?? "n/a"}`;
    out(`fal ping:  ${detail}`);
  } else {
    out("fal ping:  skipped (no key)");
  }
  out(`state dir: ${report.stateDir}`);
  out(`db:        ${report.dbOk ? "ok" : `FAILED (${report.dbError ?? "unknown"})`}`);
  if (report.hint) out(`\nHint: ${report.hint}`);
  out(report.healthy ? "\nHealthy." : "\nUnhealthy — see failures above.");
  return report.healthy ? 0 : 1;
}

async function cmdList(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["list"] ?? "");
    return 0;
  }
  const paths = statePaths();
  ensureStateDirs(paths, ["root"]);
  const db = openDatabase(paths.dbFile);
  try {
    const chars = await db.listCharacters();
    if (chars.length === 0) {
      out("No characters yet. Ask Claude to create one.");
      return 0;
    }
    const rows = chars.map((c) => ({
      identifier: c.identifier,
      name: c.name,
      done: Object.values(c.status).filter((s) => s === "done").length,
      fal: c.falCharacterId ? "published" : "-",
    }));
    const wId = Math.max(10, ...rows.map((r) => r.identifier.length));
    const wName = Math.max(4, ...rows.map((r) => r.name.length));
    out(`${"IDENTIFIER".padEnd(wId)}  ${"NAME".padEnd(wName)}  STEPS  FAL`);
    for (const r of rows) {
      out(
        `${r.identifier.padEnd(wId)}  ${r.name.padEnd(wName)}  ${String(r.done).padStart(3)}/5  ${r.fal}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

async function cmdShow(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["show"] ?? "");
    return 0;
  }
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) {
    err("Usage: character-gen show <id|identifier>");
    return 1;
  }
  const paths = statePaths();
  ensureStateDirs(paths, ["root"]);
  const db = openDatabase(paths.dbFile);
  try {
    const character = await db.getCharacter(target);
    if (!character) {
      err(`No character found matching "${target}".`);
      return 1;
    }
    const assets = await db.getAssets(character.id);
    out(JSON.stringify({ ...character, assets }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function dispatch(command: string | undefined, rest: string[]): number | Promise<number> {
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    out(ROOT_HELP);
    return 0;
  }

  switch (command) {
    case "setup":
      return cmdSetup(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "create":
      return cmdCreate(rest);
    case "sheet":
      return cmdSheet(rest);
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "open":
      return cmdOpen(rest);
    default: {
      if (STUBS.has(command)) {
        if (wantsHelp(rest)) {
          out(COMMAND_HELP[command] ?? "");
          return 0;
        }
        err(`character-gen ${command}: not implemented yet — coming soon.`);
        return 1;
      }
      err(`Unknown command: ${command}\n`);
      err(ROOT_HELP);
      return 1;
    }
  }
}

/** Runs one CLI invocation and returns the process exit code. Never throws —
 * any error is printed and becomes exit 1. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    return await dispatch(command, rest);
  } catch (error: unknown) {
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}
