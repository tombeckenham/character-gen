import { pingFal } from "./fal.ts";
import { writeStateConfig } from "./config.ts";
import type { FetchImpl, PingResult } from "./fal.ts";

/**
 * Outcome of `storeValidatedKey`:
 *  - stored + verified: fal accepted the key and it was written.
 *  - stored + unverified: verification itself failed (network/timeout/5xx/429),
 *    so we trust the user and write anyway — the ping explains why.
 *  - not stored: fal actively rejected the key (401/403); nothing was written.
 */
export type StoreKeyResult =
  | { stored: true; verified: true; configFile: string }
  | { stored: true; verified: false; configFile: string; ping: PingResult }
  | { stored: false; verified: false; ping: PingResult };

export interface StoreKeyOptions {
  key: string;
  /** Where to persist the validated key (0600). */
  configFile: string;
  /** Injectable fetch so this is testable offline. */
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

/** A 401/403 is fal actively rejecting the key — distinct from being unable to check. */
function isRejection(ping: PingResult): boolean {
  return ping.status === 401 || ping.status === 403;
}

/**
 * Pings a fal key and persists it (0600) unless fal actively rejected it.
 * Never blames the key when verification itself couldn't complete — those cases
 * are stored with `verified: false` so the caller can warn instead of erroring.
 * Shared by `character-gen setup`.
 */
export async function storeValidatedKey(options: StoreKeyOptions): Promise<StoreKeyResult> {
  const ping = await pingFal(options.key, {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });

  if (ping.ok) {
    writeStateConfig(options.configFile, { apiKey: options.key });
    return { stored: true, verified: true, configFile: options.configFile };
  }

  if (isRejection(ping)) {
    return { stored: false, verified: false, ping };
  }

  // Unverifiable (network error, timeout, 5xx, 429, …): trust the user, store it.
  writeStateConfig(options.configFile, { apiKey: options.key });
  return { stored: true, verified: false, configFile: options.configFile, ping };
}
