import { genmediaConfigPath, statePaths } from "./paths.ts";
import { readApiKeyFromFile } from "./config.ts";
import { decodeGenmediaApiKey } from "./genmedia-key.ts";
import type { KeyResolution } from "./types.ts";

export interface KeyResolutionOptions {
  /** Environment to read `FAL_KEY` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Path to the genmedia config; injectable so tests avoid the real one. */
  genmediaConfigPath?: string;
  /** Path to the state config written by `character-gen setup`. */
  stateConfigPath?: string;
}

/**
 * Resolves the fal API key in priority order:
 *   1. `FAL_KEY` env var
 *   2. `~/.genmedia/config.json` → `apiKey` (reuse the genmedia CLI's key)
 *   3. `<state dir>/config.json` → `apiKey` (written by `character-gen setup`)
 *
 * genmedia stores its `apiKey` encrypted at rest, so its value is decoded via
 * {@link decodeGenmediaApiKey} before use; an undecryptable genmedia key is
 * skipped (falls through to the state config) rather than handed to fal as
 * ciphertext. Malformed or missing config files are skipped, never thrown.
 */
export function resolveFalKey(options: KeyResolutionOptions = {}): KeyResolution {
  const env = options.env ?? process.env;

  const envKey = env["FAL_KEY"];
  if (typeof envKey === "string" && envKey.length > 0) {
    return { ok: true, key: envKey, source: "env" };
  }

  const genmediaPath = options.genmediaConfigPath ?? genmediaConfigPath(env);
  const genmediaStored = readApiKeyFromFile(genmediaPath);
  const genmediaKey = genmediaStored ? decodeGenmediaApiKey(genmediaStored) : null;
  if (genmediaKey) {
    return { ok: true, key: genmediaKey, source: "genmedia" };
  }

  const stateConfigPath = options.stateConfigPath ?? statePaths(env).configFile;
  const stateKey = readApiKeyFromFile(stateConfigPath);
  if (stateKey) {
    return { ok: true, key: stateKey, source: "config" };
  }

  return { ok: false, key: null, source: null };
}
