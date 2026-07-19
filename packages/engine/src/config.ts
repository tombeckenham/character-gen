import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StateConfig {
  apiKey?: string;
}

/**
 * Reads a JSON file and returns the parsed object, or `null` for any failure
 * (missing file, unreadable, invalid JSON, non-object). Never throws — key
 * resolution must be able to fall through a malformed config to the next source.
 */
export function readJsonFile(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extracts a non-empty string `apiKey` from a config file, or null. */
export function readApiKeyFromFile(path: string): string | null {
  const obj = readJsonFile(path);
  if (!obj) return null;
  const value = obj["apiKey"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Writes the state config as JSON with owner-only (0600) permissions. The
 * `mode` option only applies when the file is first created, so an explicit
 * `chmodSync` also tightens an existing (e.g. 0644) file on overwrite.
 */
export function writeStateConfig(configFile: string, config: StateConfig): void {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configFile, 0o600);
}
