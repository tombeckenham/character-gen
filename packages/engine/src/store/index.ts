// oxlint-disable require-await -- the async method signatures are the stable
// engine API; the folder store is synchronous filesystem work underneath.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { emptyStatus, isValidIdentifier, PIPELINE_STEPS, STEP_STATES } from "../types.ts";
import type {
  AssetKind,
  AssetRecord,
  CharacterProfile,
  CharacterRecord,
  CharacterStatus,
  PipelineStep,
  StepState,
} from "../types.ts";

/** The per-character metadata file inside `characters/<identifier>/`. */
export const CHARACTER_FILE = "character.json";

/** Thrown by `insertCharacter` when the identifier's character.json already exists. */
export class DuplicateIdentifierError extends Error {
  constructor(identifier: string) {
    super(`character folder for identifier "${identifier}" already exists`);
    this.name = "DuplicateIdentifierError";
  }
}

export interface NewCharacter {
  id?: string;
  identifier: string;
  name: string;
  profile: CharacterProfile;
  status?: CharacterStatus;
  falCharacterId?: string | null;
  /** Override the creation timestamp (defaults to now); mainly for tests. */
  createdAt?: number;
}

export interface NewAsset {
  id?: string;
  characterId: string;
  kind: AssetKind;
  falRequestId?: string | null;
  url?: string | null;
  localPath?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface CharacterPatch {
  name?: string;
  profile?: CharacterProfile;
  status?: CharacterStatus;
  falCharacterId?: string | null;
}

export interface StoreOptions {
  /** Sink for non-fatal problems the store skips over (a corrupt neighbor
   * folder during a scan, a non-portable absolute asset path). Defaults to
   * stderr so a problem is never silently dropped. */
  onWarn?: (message: string) => void;
}

/**
 * A path as persisted inside character.json — relative to the character folder
 * whenever possible. Branded so an API-facing absolute path can never be
 * assigned into a stored slot without going through `toStoredPath`.
 */
type StoredPath = string & { readonly __storedPath: true };

/** The asset shape persisted inside character.json: no characterId (implied by
 * the containing file) and `localPath` kept relative to the character folder so
 * a committed folder stays valid on any machine. */
interface StoredAsset {
  id: string;
  kind: AssetKind;
  falRequestId: string | null;
  url: string | null;
  localPath: StoredPath | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

/** The full persisted shape of one character.json. */
interface StoredCharacter {
  id: string;
  identifier: string;
  name: string;
  profile: CharacterProfile;
  status: CharacterStatus;
  falCharacterId: string | null;
  createdAt: number;
  updatedAt: number;
  assets: StoredAsset[];
}

function toRecord(stored: StoredCharacter): CharacterRecord {
  return {
    id: stored.id,
    identifier: stored.identifier,
    name: stored.name,
    profile: stored.profile,
    status: stored.status,
    falCharacterId: stored.falCharacterId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

/** Coerces a persisted status blob back to a full CharacterStatus, dropping any
 * unknown keys/values and defaulting missing steps to "pending". */
function normalizeStatus(parsed: unknown): CharacterStatus {
  const status = emptyStatus();
  if (parsed && typeof parsed === "object") {
    const source = parsed as Record<string, unknown>;
    for (const step of PIPELINE_STEPS) {
      const value = source[step];
      if (typeof value === "string" && (STEP_STATES as readonly string[]).includes(value)) {
        status[step] = value as StepState;
      }
    }
  }
  return status;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CharacterStore {
  insertCharacter(input: NewCharacter): Promise<CharacterRecord>;
  getCharacter(idOrIdentifier: string): Promise<CharacterRecord | null>;
  listCharacters(): Promise<CharacterRecord[]>;
  updateCharacter(id: string, patch: CharacterPatch): Promise<CharacterRecord | null>;
  /**
   * Sets a single pipeline step's state. Throws if the character no longer
   * exists (a vanished folder is a bug, never a silent no-op).
   */
  setStepState(id: string, step: PipelineStep, state: StepState): Promise<CharacterRecord>;
  /** Appends an asset record to the owning character.json. Throws when the
   * character does not exist. */
  insertAsset(input: NewAsset): Promise<AssetRecord>;
  /** Sets an asset's local file path after its download lands. Throws if the
   * asset record is gone. */
  setAssetLocalPath(id: string, localPath: string): Promise<AssetRecord>;
  getAssets(characterId: string): Promise<AssetRecord[]>;
  /**
   * The folder a character's media belongs in — the single source of truth for
   * where files should be written so they stay portable in character.json.
   * Validates the identifier (it lands in a file path) but does not require or
   * create the folder.
   */
  characterDir(identifier: string): string;
  close(): void;
}

/**
 * Opens the folder-backed character store rooted at `charactersDir` — one
 * `characters/<identifier>/` folder per character holding `character.json`
 * plus its media files. The directory is created lazily on first write, so
 * read-only commands (list, doctor) never litter the cwd.
 *
 * Every JSON write goes through a same-directory temp file + rename, so a
 * killed process can never leave a torn character.json. All methods do
 * synchronous filesystem work under the hood (the async signatures are the
 * stable engine API), which makes each read-modify-write atomic within a
 * process; concurrent *processes* mutating the same character are
 * last-writer-wins — acceptable for a local single-user tool.
 *
 * character.json is designed to be hand-edited and git-merged, so corruption
 * is an expected input, not an exotic one. A corrupt file read directly (by
 * identifier) throws an error naming the file; during scans (list, uuid
 * lookups) a corrupt folder is skipped with a warning through `onWarn` so one
 * bad neighbor can never take down operations on healthy characters.
 */
// The store is a single cohesive unit: one factory wiring the folder layout to
// its query methods. Splitting it would scatter closely-related IO for no gain.
// oxlint-disable-next-line max-lines-per-function
export function openStore(charactersDir: string, options: StoreOptions = {}): CharacterStore {
  const warn =
    options.onWarn ?? ((message: string): void => void process.stderr.write(`${message}\n`));
  const characterDir = (identifier: string): string => join(charactersDir, identifier);
  const characterFile = (identifier: string): string =>
    join(characterDir(identifier), CHARACTER_FILE);

  function readStored(identifier: string): StoredCharacter | null {
    const file = characterFile(identifier);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      // Only a genuinely absent file means "not a character folder" (the
      // deliberate skip case); EACCES etc. must surface, not read as empty.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`cannot read ${file}: ${errorText(error)}`, { cause: error });
    }
    let parsed: StoredCharacter;
    try {
      parsed = JSON.parse(raw) as StoredCharacter;
    } catch (error) {
      // Hand-edited/merge-conflicted JSON is the expected corruption mode —
      // the error must name the file or every surface becomes a dead end.
      throw new Error(
        `invalid JSON in ${file} — fix or delete this character folder (${errorText(error)})`,
        { cause: error },
      );
    }
    if (parsed.identifier !== identifier) {
      // Writes key off the stored identifier; letting this pass would silently
      // fork the character into old-name and new-name folders.
      throw new Error(
        `corrupt character folder: ${file} says identifier "${String(parsed.identifier)}" but the folder is named "${identifier}" — rename one to match`,
      );
    }
    const profile = parsed.profile;
    if (
      !profile ||
      typeof profile.name !== "string" ||
      profile.name.length === 0 ||
      typeof profile.identifier !== "string" ||
      profile.identifier.length === 0
    ) {
      throw new Error(`corrupt profile in ${file}: missing name/identifier`);
    }
    return {
      ...parsed,
      status: normalizeStatus(parsed.status),
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
    };
  }

  function writeStored(stored: StoredCharacter): void {
    const dir = characterDir(stored.identifier);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, CHARACTER_FILE);
    const tmp = join(dir, `.${CHARACTER_FILE}.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`);
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best-effort cleanup of our own tmp file; the original write error is
        // the one that explains the root cause and must not be replaced.
      }
      throw error;
    }
  }

  /** Every readable stored character, in no particular order. Folders without
   * a character.json (or a missing charactersDir) read as empty; a corrupt
   * folder is skipped with a warning so one bad neighbor never breaks
   * operations on healthy characters. */
  function scan(): StoredCharacter[] {
    if (!existsSync(charactersDir)) return [];
    const stored: StoredCharacter[] = [];
    for (const entry of readdirSync(charactersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const record = readStored(entry.name);
        if (record) stored.push(record);
      } catch (error) {
        warn(`store: skipping ${entry.name} — ${errorText(error)}`);
      }
    }
    return stored;
  }

  /** Finds by identifier (direct folder read — corrupt target throws with the
   * file named) or by uuid (tolerant scan). */
  function find(idOrIdentifier: string): StoredCharacter | null {
    if (isValidIdentifier(idOrIdentifier)) {
      const direct = readStored(idOrIdentifier);
      if (direct) return direct;
    }
    return scan().find((c) => c.id === idOrIdentifier) ?? null;
  }

  function toAssetRecord(stored: StoredCharacter, asset: StoredAsset): AssetRecord {
    return {
      id: asset.id,
      characterId: stored.id,
      kind: asset.kind,
      falRequestId: asset.falRequestId,
      url: asset.url,
      localPath:
        asset.localPath === null || isAbsolute(asset.localPath)
          ? asset.localPath
          : join(characterDir(stored.identifier), asset.localPath),
      meta: asset.meta,
      createdAt: asset.createdAt,
    };
  }

  /** Stores `localPath` relative to the character folder when it lives inside
   * it (the normal case), so committed folders stay portable. A path outside
   * the folder is kept as-is but warned about — it breaks portability. */
  function toStoredPath(stored: StoredCharacter, localPath: string): StoredPath {
    const rel = relative(characterDir(stored.identifier), localPath);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) return rel as StoredPath;
    warn(
      `store: asset path ${localPath} is outside characters/${stored.identifier}/ — stored as-is; this character folder will not be portable`,
    );
    return localPath as StoredPath;
  }

  return {
    async insertCharacter(input) {
      if (!isValidIdentifier(input.identifier)) {
        throw new Error(
          `invalid identifier "${input.identifier}" — must be a lowercase slug of letters, digits, and hyphens`,
        );
      }
      if (input.profile.identifier !== input.identifier) {
        // The identifier is stored twice (top level + inside the profile);
        // letting them disagree here would poison every later read.
        throw new Error(
          `insertCharacter: profile.identifier "${input.profile.identifier}" does not match identifier "${input.identifier}"`,
        );
      }
      if (existsSync(characterFile(input.identifier))) {
        throw new DuplicateIdentifierError(input.identifier);
      }
      const now = input.createdAt ?? Date.now();
      const stored: StoredCharacter = {
        id: input.id ?? randomUUID(),
        identifier: input.identifier,
        name: input.name,
        profile: input.profile,
        status: input.status ?? emptyStatus(),
        falCharacterId: input.falCharacterId ?? null,
        createdAt: now,
        updatedAt: now,
        assets: [],
      };
      writeStored(stored);
      return toRecord(stored);
    },

    async getCharacter(idOrIdentifier) {
      const stored = find(idOrIdentifier);
      return stored ? toRecord(stored) : null;
    },

    async listCharacters() {
      // Newest first; same-millisecond ties break by identifier so the order
      // is deterministic across filesystems.
      return scan()
        .toSorted((a, b) => b.createdAt - a.createdAt || a.identifier.localeCompare(b.identifier))
        .map((stored) => toRecord(stored));
    },

    async updateCharacter(id, patch) {
      const stored = find(id);
      if (!stored) return null;
      if (patch.name !== undefined) stored.name = patch.name;
      if (patch.profile !== undefined) stored.profile = patch.profile;
      if (patch.status !== undefined) stored.status = normalizeStatus(patch.status);
      if (patch.falCharacterId !== undefined) stored.falCharacterId = patch.falCharacterId;
      stored.updatedAt = Date.now();
      writeStored(stored);
      return toRecord(stored);
    },

    async setStepState(id, step, state) {
      const stored = find(id);
      if (!stored) throw new Error(`setStepState: character ${id} not found`);
      stored.status[step] = state;
      stored.updatedAt = Date.now();
      writeStored(stored);
      return toRecord(stored);
    },

    async insertAsset(input) {
      const stored = find(input.characterId);
      if (!stored) throw new Error(`insertAsset: character ${input.characterId} not found`);
      const asset: StoredAsset = {
        id: input.id ?? randomUUID(),
        kind: input.kind,
        falRequestId: input.falRequestId ?? null,
        url: input.url ?? null,
        localPath:
          input.localPath === null || input.localPath === undefined
            ? null
            : toStoredPath(stored, input.localPath),
        meta: input.meta ?? null,
        createdAt: Date.now(),
      };
      stored.assets.push(asset);
      writeStored(stored);
      return toAssetRecord(stored, asset);
    },

    async setAssetLocalPath(id, localPath) {
      for (const stored of scan()) {
        const asset = stored.assets.find((a) => a.id === id);
        if (!asset) continue;
        asset.localPath = toStoredPath(stored, localPath);
        writeStored(stored);
        return toAssetRecord(stored, asset);
      }
      throw new Error(`setAssetLocalPath: asset ${id} not found`);
    },

    async getAssets(characterId) {
      const stored = find(characterId);
      if (!stored) return [];
      // Oldest first; the array is append-only so index order breaks ties.
      return stored.assets
        .map((asset) => toAssetRecord(stored, asset))
        .toSorted((a, b) => a.createdAt - b.createdAt);
    },

    characterDir(identifier) {
      if (!isValidIdentifier(identifier)) {
        throw new Error(`characterDir: invalid identifier "${identifier}"`);
      }
      return characterDir(identifier);
    },

    close() {
      // Nothing to release — kept so call sites read the same as before.
    },
  };
}
