import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Resolves the state directory root. `CHARACTER_GEN_HOME` overrides the default
 * `~/.character-gen`, which is required so tests never touch the real home dir.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CHARACTER_GEN_HOME"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".character-gen");
}

export interface StatePaths {
  root: string;
  dbFile: string;
  configFile: string;
  mediaDir: string;
  galleryDir: string;
}

export function statePaths(env: NodeJS.ProcessEnv = process.env): StatePaths {
  const root = stateDir(env);
  return {
    root,
    dbFile: join(root, "db.sqlite"),
    configFile: join(root, "config.json"),
    mediaDir: join(root, "media"),
    galleryDir: join(root, "gallery"),
  };
}

/** Creates the state root (and given subdirs) lazily; safe to call repeatedly. */
export function ensureStateDirs(
  paths: StatePaths,
  subdirs: ReadonlyArray<keyof StatePaths> = ["root"],
): void {
  for (const key of subdirs) {
    mkdirSync(paths[key], { recursive: true });
  }
}

/** Default path to the genmedia CLI config, whose `apiKey` we can reuse. */
export function genmediaConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  // Derived from an env-overridable HOME so tests can isolate against the real
  // ~/.genmedia/config.json that exists on developer machines.
  const home = env["HOME"] ?? homedir();
  return join(home, ".genmedia", "config.json");
}
