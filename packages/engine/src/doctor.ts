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
    await db.listCharacters();
    db.close();
    dbOk = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  const healthy = nodeOk && key.ok && ping !== null && ping.ok && dbOk;

  return {
    nodeVersion,
    nodeOk,
    keySource: key.ok ? key.source : null,
    ping,
    stateDir: paths.root,
    dbOk,
    dbError,
    healthy,
  };
}
