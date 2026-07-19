import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidIdentifier } from "./character.ts";
import { DATA_GLOBAL } from "./gallery-data.ts";
import type { GalleryAssetEntry, GalleryCharacter, GalleryData } from "./gallery-data.ts";
import type { AssetRecord, CharacterRecord } from "./types.ts";
import type { Database } from "./db/index.ts";

/** Settings key holding the monotonically increasing gallery version counter. */
export const GALLERY_VERSION_KEY = "gallery_version";

/** Error message when neither a built SPA nor a previously written gallery
 * page exists. Kept as a constant so the CLI/tests match it exactly. */
export const GALLERY_NOT_BUILT =
  "gallery not built — run `bun run build:gallery` first (gallery-app/dist/index.html is missing)";

/** The built SPA's location relative to this source file (repo layout). */
export function defaultSpaHtmlPath(): string {
  return fileURLToPath(new URL("../../../gallery-app/dist/index.html", import.meta.url));
}

export interface GalleryWriteDeps {
  db: Database;
  /** Target directory, `<state>/gallery` (created if absent). */
  galleryDir: string;
  /** Override the built SPA index.html location (tests). */
  spaHtmlPath?: string;
  /** Sink for non-fatal skip warnings (missing media files etc.). */
  onWarn?: (message: string) => void;
}

export interface GalleryWriteResult {
  galleryDir: string;
  indexHtml: string;
  dataFile: string;
  version: number;
  characterCount: number;
}

const OPTIONAL_PROFILE_FIELDS = [
  "archetype",
  "personality",
  "backstory",
  "visualCanon",
  "voiceDescription",
] as const;

/**
 * Copies a character's downloadable assets into `<galleryDir>/media/<identifier>/`
 * and returns their gallery-relative entries. Assets without a local file (failed
 * downloads have a null `local_path`, per the sheet step) are skipped; a recorded
 * path whose file has since vanished is skipped with a warning.
 */
function copyAssets(
  character: CharacterRecord,
  assets: AssetRecord[],
  galleryDir: string,
  warn: (message: string) => void,
): GalleryAssetEntry[] {
  const entries: GalleryAssetEntry[] = [];
  let charMediaDir: string | null = null;
  for (const asset of assets) {
    if (asset.localPath === null) continue;
    if (!existsSync(asset.localPath)) {
      warn(`gallery: skipping ${character.identifier}/${asset.kind} — missing ${asset.localPath}`);
      continue;
    }
    if (charMediaDir === null) {
      charMediaDir = join(galleryDir, "media", character.identifier);
      mkdirSync(charMediaDir, { recursive: true });
    }
    const fileName = basename(asset.localPath);
    copyFileSync(asset.localPath, join(charMediaDir, fileName));
    // Built by hand (not join) so the payload always uses URL-style slashes.
    entries.push({ kind: asset.kind, path: `media/${character.identifier}/${fileName}` });
  }
  return entries;
}

function toGalleryCharacter(character: CharacterRecord, assets: GalleryAssetEntry[]) {
  const entry: GalleryCharacter = {
    identifier: character.identifier,
    name: character.name,
    status: character.status,
    assets,
  };
  for (const field of OPTIONAL_PROFILE_FIELDS) {
    const value = character.profile[field];
    if (typeof value === "string" && value.length > 0) entry[field] = value;
  }
  return entry;
}

/** Reads and bumps the persisted version counter; strictly increases across
 * separate writer runs and CLI invocations. */
async function nextVersion(db: Database): Promise<number> {
  const raw = await db.getSetting(GALLERY_VERSION_KEY);
  const previous = raw === null ? 0 : Number(raw);
  const version = (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
  await db.setSetting(GALLERY_VERSION_KEY, String(version));
  return version;
}

/**
 * Writes the complete gallery: the built SPA as `index.html`, every character's
 * local media copied under `media/<identifier>/`, and finally `data.js` — written
 * to a temp file and renamed into place so the polling page never sees a torn
 * file. When the built SPA is missing, an already-present `index.html` is kept
 * (a refresh mid-pipeline must not depend on dist/); with neither, this throws
 * GALLERY_NOT_BUILT.
 */
export async function writeGallery(deps: GalleryWriteDeps): Promise<GalleryWriteResult> {
  const warn = deps.onWarn ?? (() => {});
  const { galleryDir } = deps;
  mkdirSync(galleryDir, { recursive: true });

  const indexHtml = join(galleryDir, "index.html");
  const spaHtml = deps.spaHtmlPath ?? defaultSpaHtmlPath();
  if (existsSync(spaHtml)) {
    copyFileSync(spaHtml, indexHtml);
  } else if (!existsSync(indexHtml)) {
    throw new Error(GALLERY_NOT_BUILT);
  }

  const records = await deps.db.listCharacters();
  const characters: GalleryCharacter[] = [];
  for (const character of records) {
    // Never trust a stored identifier in a file path (defense in depth).
    if (!isValidIdentifier(character.identifier)) {
      warn(`gallery: skipping character with invalid identifier "${character.identifier}"`);
      continue;
    }
    // Sequential by design: the copies are local file I/O per character.
    // oxlint-disable-next-line no-await-in-loop
    const assets = await deps.db.getAssets(character.id);
    characters.push(toGalleryCharacter(character, copyAssets(character, assets, galleryDir, warn)));
  }

  const payload: GalleryData = { version: await nextVersion(deps.db), characters };
  const dataFile = join(galleryDir, "data.js");
  // Same-directory temp file so the rename is atomic on the same filesystem.
  const tmpFile = join(galleryDir, `.data.js.${process.pid}.tmp`);
  try {
    writeFileSync(tmpFile, `window.${DATA_GLOBAL} = ${JSON.stringify(payload)};\n`);
    renameSync(tmpFile, dataFile);
  } catch (error) {
    rmSync(tmpFile, { force: true });
    throw error;
  }

  return {
    galleryDir,
    indexHtml,
    dataFile,
    version: payload.version,
    characterCount: characters.length,
  };
}

/**
 * Rewrites the gallery only when it already exists (i.e. the user has run
 * `character-gen open` before); pipeline steps call this after every state
 * change. Never throws — a gallery refresh failure must not fail the pipeline;
 * it is reported through `onWarn` instead.
 */
export async function refreshGalleryIfPresent(deps: GalleryWriteDeps): Promise<void> {
  if (!existsSync(deps.galleryDir)) return;
  try {
    await writeGallery(deps);
  } catch (error) {
    deps.onWarn?.(
      `warning: gallery refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
