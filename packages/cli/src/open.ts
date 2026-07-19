import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ensureStateDirs, openDatabase, statePaths, writeGallery } from "@character-gen/engine";
import type { GalleryWriteResult } from "@character-gen/engine";
import { COMMAND_HELP } from "./help.ts";
import { err, out, wantsHelp } from "./io.ts";

/** Launches the platform opener; injectable so tests never spawn anything. */
export type Spawner = (command: string, args: string[]) => void;

const defaultSpawner: Spawner = (command, args) => {
  // Detached + unref so the CLI exits immediately while the browser launches.
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
};

/** The platform's URL opener invocation for `url`. */
export function openerCommand(platform: string, url: string): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is a cmd built-in; the empty string is its window-title slot.
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

export interface OpenDeps {
  env?: NodeJS.ProcessEnv;
  spawner?: Spawner;
  platform?: string;
  /** Override the built SPA location (tests). */
  spaHtmlPath?: string;
}

/** `character-gen open [--no-browser]` — write the gallery, then open it. */
export async function cmdOpen(rest: string[], deps: OpenDeps = {}): Promise<number> {
  if (wantsHelp(rest)) {
    out(COMMAND_HELP["open"] ?? "");
    return 0;
  }
  const { values } = parseArgs({
    args: rest,
    options: { "no-browser": { type: "boolean" } },
    allowPositionals: false,
  });

  const paths = statePaths(deps.env ?? process.env);
  ensureStateDirs(paths, ["root"]);
  const db = openDatabase(paths.dbFile);
  let result: GalleryWriteResult;
  try {
    result = await writeGallery({
      db,
      galleryDir: paths.galleryDir,
      onWarn: err,
      ...(deps.spaHtmlPath === undefined ? {} : { spaHtmlPath: deps.spaHtmlPath }),
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db.close();
  }

  const url = pathToFileURL(result.indexHtml).href;
  out(
    `Gallery written: ${result.indexHtml} (${result.characterCount} characters, v${result.version})`,
  );
  out(url);
  if (values["no-browser"]) return 0;

  const { command, args } = openerCommand(deps.platform ?? process.platform, url);
  (deps.spawner ?? defaultSpawner)(command, args);
  return 0;
}
