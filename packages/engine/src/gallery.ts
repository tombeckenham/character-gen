import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidIdentifier } from "./character.ts";
import { DATA_GLOBAL, OPTIONAL_PROFILE_FIELDS } from "./gallery-data.ts";
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
  /** Sink for non-fatal warnings (skipped media, refresh failures). Required so
   * no caller can silently drop them. */
  onWarn: (message: string) => void;
}

export interface GalleryWriteResult {
  galleryDir: string;
  indexHtml: string;
  dataFile: string;
  version: number;
  characterCount: number;
}

/**
 * Copies one media file into the gallery under a content-addressed name
 * (`<stem>.<hash8><ext>`). The hash makes the `src` change whenever the bytes
 * change — a browser re-fetches a regenerated image instead of showing its
 * cached copy — and means an existing target name never needs rewriting. First
 * writes go through a tmp + rename so a killed process can't leave a torn file
 * under a valid name.
 */
function copyContentAddressed(sourcePath: string, destDir: string): string {
  const bytes = readFileSync(sourcePath);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const { name, ext } = parse(sourcePath);
  const fileName = `${name}.${hash}${ext}`;
  const dest = join(destDir, fileName);
  if (!existsSync(dest)) {
    const tmp = `${dest}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return fileName;
}

/**
 * Copies a character's downloadable assets into `<galleryDir>/media/<identifier>/`
 * and returns their gallery-relative entries. Assets without a local file (failed
 * downloads have a null `local_path`, per the sheet step) are skipped; a vanished
 * file or a failed copy is skipped with a warning — one bad asset must never
 * abort the whole gallery write.
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
    try {
      const fileName = copyContentAddressed(asset.localPath, charMediaDir);
      // Built by hand (not join) so the payload always uses URL-style slashes.
      entries.push({ kind: asset.kind, path: `media/${character.identifier}/${fileName}` });
    } catch (error) {
      warn(
        `gallery: skipping ${character.identifier}/${asset.kind} — copy failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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

/**
 * Writes the complete gallery: the built SPA as `index.html`, every character's
 * local media copied under `media/<identifier>/`, and finally `data.js` — written
 * to a temp file and renamed into place so the polling page never sees a torn
 * file. When the built SPA is missing, an already-present `index.html` is kept
 * (a refresh mid-pipeline must not depend on dist/); with neither, this throws
 * GALLERY_NOT_BUILT.
 */
export async function writeGallery(deps: GalleryWriteDeps): Promise<GalleryWriteResult> {
  const { galleryDir, onWarn: warn } = deps;
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
    // Sequential by design: each iteration is one local DB read plus local
    // file copies for that character.
    // oxlint-disable-next-line no-await-in-loop
    const assets = await deps.db.getAssets(character.id);
    characters.push(toGalleryCharacter(character, copyAssets(character, assets, galleryDir, warn)));
  }

  // Bumped atomically in the DB so concurrent writers always mint distinct,
  // strictly increasing versions.
  const payload: GalleryData = {
    version: await deps.db.bumpCounter(GALLERY_VERSION_KEY),
    characters,
  };
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
    // A plain Error is an operational failure and its message suffices; any
    // other throw (TypeError etc.) is a programmer bug — keep the stack so it
    // stays diagnosable despite being swallowed here.
    const detail =
      error instanceof Error
        ? error.constructor === Error
          ? error.message
          : (error.stack ?? error.message)
        : String(error);
    deps.onWarn(`warning: gallery refresh failed: ${detail}`);
  }
}
