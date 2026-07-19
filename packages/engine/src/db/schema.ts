import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// JSON-bearing columns (profile, status, meta) are stored as plain TEXT and
// parsed in the repository layer, so the schema stays driver-agnostic and the
// round-trip is exercised by tests rather than trusting a json column mode.

export const characters = sqliteTable("characters", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  profile: text("profile").notNull(),
  status: text("status").notNull(),
  falCharacterId: text("fal_character_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const assets = sqliteTable("assets", {
  id: text("id").primaryKey(),
  characterId: text("character_id").notNull(),
  kind: text("kind").notNull(),
  falRequestId: text("fal_request_id"),
  url: text("url"),
  localPath: text("local_path"),
  meta: text("meta"),
  createdAt: integer("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * Idempotent DDL applied on every open (no drizzle-kit at runtime). Kept in sync
 * with the Drizzle table definitions above by round-trip tests.
 */
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,
  fal_character_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  kind TEXT NOT NULL,
  fal_request_id TEXT,
  url TEXT,
  local_path TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_character ON assets(character_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
