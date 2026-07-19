import { openStore } from "./store/index.ts";
import { resolveFalKey } from "./key.ts";
import { pingFal } from "./fal.ts";
import { statePaths } from "./paths.ts";
import type { FetchImpl, PingResult } from "./fal.ts";
import type { KeySource } from "./types.ts";

/** Minimum Node version: the CLI's `bin` runs `src/index.ts` directly, which
 * needs Node's unflagged type stripping (22.18+/23.6+). */
export const MIN_NODE = { major: 22, minor: 18 } as const;

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
  /** The character folders root the store would read/write. */
  charactersDir: string;
  storeOk: boolean;
  storeError: string | null;
  healthy: boolean;
  /** Actionable remediation hint when the failure has a known cause. */
  hint: string | null;
}

/**
 * When the key came from the genmedia config but fal rejects it with 401, the
 * decoded key is genuinely invalid (revoked, or from a different account).
 * Point the user at `setup` to store a working key that takes precedence.
 */
function doctorHint(keySource: KeySource | null, ping: PingResult | null): string | null {
  if (keySource === "genmedia" && ping && !ping.ok && ping.status === 401) {
    return "Key decoded from ~/.genmedia/config.json but fal rejected it (401) — it may be revoked or from a different account. Run `character-gen setup` to store a working key.";
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
 * Reads the whole store once, reporting corrupt character folders (surfaced as
 * scan warnings) as unhealthy with the folders named. A missing charactersDir
 * reads as an empty store — the doctor must not create folders in the user's
 * cwd just by being run.
 */
async function checkStore(
  charactersDir: string,
): Promise<{ storeOk: boolean; storeError: string | null }> {
  try {
    const warnings: string[] = [];
    const store = openStore(charactersDir, { onWarn: (m) => warnings.push(m) });
    try {
      await store.listCharacters();
      return { storeOk: warnings.length === 0, storeError: warnings.join("; ") || null };
    } finally {
      store.close();
    }
  } catch (err) {
    return { storeOk: false, storeError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Gathers the doctor report: Node version, active key source, fal ping, state
 * dir path, and character-store readability. `healthy` is true only when Node
 * is new enough, a key resolved and pinged OK, and the store read cleanly.
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

  const { storeOk, storeError } = await checkStore(paths.charactersDir);

  const healthy = nodeOk && key.ok && ping !== null && ping.ok && storeOk;
  const keySource = key.ok ? key.source : null;

  return {
    nodeVersion,
    nodeOk,
    keySource,
    ping,
    stateDir: paths.root,
    charactersDir: paths.charactersDir,
    storeOk,
    storeError,
    healthy,
    hint: doctorHint(keySource, ping),
  };
}
