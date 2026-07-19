import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Resolves the config directory root. `CHARACTER_GEN_HOME` overrides the
 * default `~/.character-gen`, which is required so tests never touch the real
 * home dir.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CHARACTER_GEN_HOME"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".character-gen");
}

export interface StatePaths {
  /** Config home: `~/.character-gen` (or CHARACTER_GEN_HOME). */
  root: string;
  configFile: string;
  /** The git-committable character folders: `<cwd>/characters` by default. */
  charactersDir: string;
  /** Derived gallery output: `<cwd>/gallery` by default. */
  galleryDir: string;
}

/**
 * Resolves all state locations. Characters and the gallery are project-local
 * (under the current working directory) so character folders can be committed
 * to git; only the config (API key) lives in the home-dir root. When
 * `CHARACTER_GEN_HOME` is set it relocates everything under one directory —
 * tests rely on that for isolation, and it doubles as an opt-in global library.
 */
export function statePaths(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): StatePaths {
  const root = stateDir(env);
  const override = env["CHARACTER_GEN_HOME"];
  const projectRoot = override && override.length > 0 ? override : cwd;
  return {
    root,
    configFile: join(root, "config.json"),
    charactersDir: join(projectRoot, "characters"),
    galleryDir: join(projectRoot, "gallery"),
  };
}

/** Idempotent: creates the state root (and any given subdirs) if absent. */
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
