import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-sqlite";
import { eq, or, desc } from "drizzle-orm";
import { assets, characters, settings, SCHEMA_DDL } from "./schema.ts";
import { emptyStatus } from "../types.ts";
import type {
  AssetKind,
  AssetRecord,
  CharacterProfile,
  CharacterRecord,
  CharacterStatus,
} from "../types.ts";

export interface NewCharacter {
  id?: string;
  identifier: string;
  name: string;
  profile: CharacterProfile;
  status?: CharacterStatus;
  falCharacterId?: string | null;
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

type CharacterRow = typeof characters.$inferSelect;
type AssetRow = typeof assets.$inferSelect;

function rowToCharacter(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    identifier: row.identifier,
    name: row.name,
    profile: JSON.parse(row.profile) as CharacterProfile,
    status: JSON.parse(row.status) as CharacterStatus,
    falCharacterId: row.falCharacterId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    characterId: row.characterId,
    kind: row.kind as AssetKind,
    falRequestId: row.falRequestId,
    url: row.url,
    localPath: row.localPath,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null,
    createdAt: row.createdAt,
  };
}

export interface Database {
  insertCharacter(input: NewCharacter): Promise<CharacterRecord>;
  getCharacter(idOrIdentifier: string): Promise<CharacterRecord | null>;
  listCharacters(): Promise<CharacterRecord[]>;
  updateCharacter(id: string, patch: CharacterPatch): Promise<CharacterRecord | null>;
  insertAsset(input: NewAsset): Promise<AssetRecord>;
  getAssets(characterId: string): Promise<AssetRecord[]>;
  setSetting(key: string, value: string): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  close(): void;
}

/**
 * Opens (creating if needed) the SQLite database at `dbFile`, applies the schema
 * idempotently, and enables WAL + foreign keys. Uses Node's built-in
 * `node:sqlite` driver through Drizzle — zero native modules.
 */
// The repository is a single cohesive unit: one factory wiring the connection to
// its query methods. Splitting it would scatter closely-related SQL for no gain.
// oxlint-disable-next-line max-lines-per-function
export function openDatabase(dbFile: string): Database {
  const client = new DatabaseSync(dbFile);
  client.exec("PRAGMA journal_mode = WAL;");
  client.exec("PRAGMA foreign_keys = ON;");
  client.exec(SCHEMA_DDL);
  const db = drizzle({ client });

  return {
    async insertCharacter(input) {
      const now = Date.now();
      const record: CharacterRecord = {
        id: input.id ?? randomUUID(),
        identifier: input.identifier,
        name: input.name,
        profile: input.profile,
        status: input.status ?? emptyStatus(),
        falCharacterId: input.falCharacterId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(characters).values({
        id: record.id,
        identifier: record.identifier,
        name: record.name,
        profile: JSON.stringify(record.profile),
        status: JSON.stringify(record.status),
        falCharacterId: record.falCharacterId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
      return record;
    },

    async getCharacter(idOrIdentifier) {
      const rows = await db
        .select()
        .from(characters)
        .where(or(eq(characters.id, idOrIdentifier), eq(characters.identifier, idOrIdentifier)))
        .limit(1);
      const row = rows[0];
      return row ? rowToCharacter(row) : null;
    },

    async listCharacters() {
      const rows = await db.select().from(characters).orderBy(desc(characters.createdAt));
      return rows.map((row) => rowToCharacter(row));
    },

    async updateCharacter(id, patch) {
      const set: Partial<CharacterRow> = { updatedAt: Date.now() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.profile !== undefined) set.profile = JSON.stringify(patch.profile);
      if (patch.status !== undefined) set.status = JSON.stringify(patch.status);
      if (patch.falCharacterId !== undefined) set.falCharacterId = patch.falCharacterId;
      await db.update(characters).set(set).where(eq(characters.id, id));
      const rows = await db.select().from(characters).where(eq(characters.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToCharacter(row) : null;
    },

    async insertAsset(input) {
      const record: AssetRecord = {
        id: input.id ?? randomUUID(),
        characterId: input.characterId,
        kind: input.kind,
        falRequestId: input.falRequestId ?? null,
        url: input.url ?? null,
        localPath: input.localPath ?? null,
        meta: input.meta ?? null,
        createdAt: Date.now(),
      };
      await db.insert(assets).values({
        id: record.id,
        characterId: record.characterId,
        kind: record.kind,
        falRequestId: record.falRequestId,
        url: record.url,
        localPath: record.localPath,
        meta: record.meta ? JSON.stringify(record.meta) : null,
        createdAt: record.createdAt,
      });
      return record;
    },

    async getAssets(characterId) {
      const rows = await db
        .select()
        .from(assets)
        .where(eq(assets.characterId, characterId))
        .orderBy(assets.createdAt);
      return rows.map((row) => rowToAsset(row));
    },

    async setSetting(key, value) {
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
    },

    async getSetting(key) {
      const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
      const row = rows[0];
      return row ? row.value : null;
    },

    close() {
      client.close();
    },
  };
}
