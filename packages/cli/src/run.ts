import { parseArgs } from "node:util";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import {
  ensureStateDirs,
  openDatabase,
  pingFal,
  runDoctor,
  statePaths,
  writeStateConfig,
} from "@character-gen/engine";
import { COMMAND_HELP, ROOT_HELP } from "./help.ts";

function out(line: string): void {
  output.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Pipeline commands not yet built, mapped to the phase that delivers them. */
const STUBS: Record<string, number> = {
  create: 2,
  sheet: 2,
  open: 3,
  turnaround: 5,
  voice: 6,
  speak: 6,
  publish: 7,
  extract: 8,
};

function wantsHelp(rest: string[]): boolean {
  return rest.includes("--help") || rest.includes("-h");
}

async function cmdSetup(rest: string[]): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["setup"] ?? "");
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: { "api-key": { type: "string" } },
    allowPositionals: false,
  });

  let key = values["api-key"];
  if (!key) {
    const rl = readline.createInterface({ input, output });
    key = (await rl.question("Enter your fal API key: ")).trim();
    rl.close();
  }
  if (!key) {
    err("No API key provided.");
    return 1;
  }

  out("Validating key against fal…");
  const ping = await pingFal(key);
  if (!ping.ok) {
    err(`Key validation failed (${ping.status ?? ping.error ?? "unknown error"}).`);
    return 1;
  }

  const paths = statePaths();
  writeStateConfig(paths.configFile, { apiKey: key });
  out(`Key validated and saved to ${paths.configFile} (mode 0600).`);
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
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    default: {
      const phase = STUBS[command];
      if (phase !== undefined) {
        if (wantsHelp(rest)) {
          out(COMMAND_HELP[command] ?? "");
          return 0;
        }
        err(`character-gen ${command}: not implemented yet (phase ${phase}).`);
        return 1;
      }
      err(`Unknown command: ${command}\n`);
      err(ROOT_HELP);
      return 1;
    }
  }
}

/** Runs one CLI invocation and returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    return await dispatch(command, rest);
  } catch (error: unknown) {
    err(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}
