import { parseArgs } from "node:util";
import {
  describeError,
  ensureStateDirs,
  makeGenmediaRunner,
  openStore,
  resolveFalKey,
  runPublish,
  statePaths,
} from "@character-gen/engine";
import type { GenmediaRunner } from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";
import { refreshGallery } from "./pipeline.ts";

export interface PublishDeps {
  env?: NodeJS.ProcessEnv;
  /** Override the genmedia subprocess runner (tests never spawn anything). */
  runGenmedia?: GenmediaRunner;
}

/**
 * `publish <char>`: push the character to fal Assets Characters via genmedia.
 * The key character-gen resolved (env → genmedia config → setup) is passed to
 * the genmedia subprocess as FAL_KEY so both tools agree on the credential.
 */
export async function cmdPublish(rest: string[], deps: PublishDeps = {}): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["publish"] ?? "");
    return 0;
  }
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const target = positionals[0];
  if (!target) {
    err("Usage: character-gen publish <id|identifier>");
    return 1;
  }

  const env = deps.env ?? process.env;
  const paths = statePaths(env);
  ensureStateDirs(paths, ["root"]);
  const store = openStore(paths.charactersDir);
  try {
    const character = await store.getCharacter(target);
    if (!character) {
      err(`No character found matching "${target}".`);
      return 1;
    }
    let runGenmedia = deps.runGenmedia;
    if (!runGenmedia) {
      // The Assets Characters write endpoints require an ADMIN-scoped key, so
      // FAL_ADMIN_KEY (when set) beats the regular resolution chain.
      const adminKey = env["FAL_ADMIN_KEY"];
      const key = resolveFalKey({ env });
      const falKey = adminKey && adminKey.length > 0 ? adminKey : key.ok ? key.key : undefined;
      runGenmedia = makeGenmediaRunner({ ...env, ...(falKey ? { FAL_KEY: falKey } : {}) });
    }
    let succeeded: boolean;
    try {
      const outcome = await runPublish(character, {
        store,
        runGenmedia,
        onProgress: (message) => err(message),
      });
      out(
        `${outcome.updated ? "Updated" : "Published"} ${character.name} on fal Assets (character ${outcome.falCharacterId}, ${outcome.referenceCount} reference images).`,
      );
      succeeded = true;
    } catch (error) {
      err(`Publish failed: ${describeError(error)}`);
      succeeded = false;
    }
    // Either way the status chip changed (done/error) — reflect it live.
    await refreshGallery(store, paths);
    return succeeded ? 0 : 1;
  } finally {
    store.close();
  }
}
