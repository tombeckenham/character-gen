import { openDatabase } from "./db/index.ts";
import { resolveFalKey } from "./key.ts";
import { pingFal } from "./fal.ts";
import { ensureStateDirs, statePaths } from "./paths.ts";
import type { FetchImpl, PingResult } from "./fal.ts";
import type { KeySource } from "./types.ts";

/** Minimum Node version for the built-in `node:sqlite` driver. */
export const MIN_NODE = { major: 22, minor: 13 } as const;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const match = /^(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > MIN_NODE.major) return true;
  return major === MIN_NODE.major && minor >= MIN_NODE.minor;
}

export interface DoctorReport {
  nodeVersion: string;
  nodeOk: boolean;
  keySource: KeySource | null;
  ping: PingResult | null;
  stateDir: string;
  dbOk: boolean;
  dbError: string | null;
  healthy: boolean;
  /** Actionable remediation hint when the failure has a known cause. */
  hint: string | null;
}

/**
 * When the key came from the genmedia config but fal rejects it with 401, the
 * likely cause is that genmedia stored the key encrypted at rest (its raw value
 * is unusable). Point the user at `setup` to store a working key.
 */
function doctorHint(keySource: KeySource | null, ping: PingResult | null): string | null {
  if (keySource === "genmedia" && ping && !ping.ok && ping.status === 401) {
    return "Key found in ~/.genmedia/config.json but fal rejected it (401) — genmedia may store it encrypted on this machine. Run `character-gen setup` to store a working key.";
  }
  return null;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  genmediaConfigPath?: string;
  stateConfigPath?: string;
}

/**
 * Gathers the doctor report: Node version, active key source, fal ping, state
 * dir path, and DB reachability. `healthy` is true only when Node is new enough,
 * a key resolved and pinged OK, and the DB opened.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const paths = statePaths(env);
  const nodeVersion = process.versions.node;
  const nodeOk = nodeVersionOk(nodeVersion);

  const key = resolveFalKey({
    env,
    ...(options.genmediaConfigPath ? { genmediaConfigPath: options.genmediaConfigPath } : {}),
    ...(options.stateConfigPath ? { stateConfigPath: options.stateConfigPath } : {}),
  });

  let ping: PingResult | null = null;
  if (key.ok) {
    ping = await pingFal(key.key, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  }

  let dbOk = false;
  let dbError: string | null = null;
  try {
    ensureStateDirs(paths, ["root"]);
    const db = openDatabase(paths.dbFile);
    try {
      await db.listCharacters();
      dbOk = true;
    } finally {
      db.close();
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const healthy = nodeOk && key.ok && ping !== null && ping.ok && dbOk;
  const keySource = key.ok ? key.source : null;

  return {
    nodeVersion,
    nodeOk,
    keySource,
    ping,
    stateDir: paths.root,
    dbOk,
    dbError,
    healthy,
    hint: doctorHint(keySource, ping),
  };
}
