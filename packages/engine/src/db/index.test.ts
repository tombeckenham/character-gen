import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./index.ts";
import type { CharacterProfile } from "../types.ts";

function tmpDbFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-db-"));
  return { file: join(dir, "db.sqlite"), dir };
}

/** Flattens an error and its `cause` chain — Drizzle wraps the sqlite error
 * (with the real "UNIQUE/FOREIGN KEY constraint failed" text) in `cause`. */
function errorChainText(err: unknown): string {
  let text = "";
  let current: unknown = err;
  while (current instanceof Error) {
    text += `${current.message}\n`;
    current = (current as { cause?: unknown }).cause;
  }
  return text;
}

const profile: CharacterProfile = {
  name: "Isolde the Lighthouse Keeper",
  identifier: "isolde-keeper",
  archetype: "weathered sentinel",
  visualCanon: "silver braid, oilskin coat, lantern-scarred hands",
  voiceDescription: "low, salt-worn, deliberate",
};

test("insert then get a character by id and by identifier, round-tripping JSON", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    const created = await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde the Lighthouse Keeper",
      profile,
    });
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    const byId = await db.getCharacter(created.id);
    assert.ok(byId);
    assert.equal(byId.identifier, "isolde-keeper");
    assert.deepEqual(byId.profile, profile);
    assert.equal(byId.status.profile, "pending");

    const byIdentifier = await db.getCharacter("isolde-keeper");
    assert.ok(byIdentifier);
    assert.equal(byIdentifier.id, created.id);

    assert.equal(await db.getCharacter("does-not-exist"), null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update character status and fal id", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    const created = await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    const updated = await db.updateCharacter(created.id, {
      status: {
        profile: "done",
        sheet: "done",
        turnaround: "running",
        voice: "pending",
        publish: "pending",
      },
      falCharacterId: "fal-char-123",
    });
    assert.ok(updated);
    assert.equal(updated.status.sheet, "done");
    assert.equal(updated.status.turnaround, "running");
    assert.equal(updated.falCharacterId, "fal-char-123");
    assert.ok(updated.updatedAt >= created.updatedAt);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert and query assets, round-tripping meta JSON", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    const character = await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    await db.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: "https://fal.media/master.png",
      localPath: "/media/isolde/master.png",
      meta: { model: "openai/gpt-image-2", seed: 42 },
    });
    await db.insertAsset({
      characterId: character.id,
      kind: "angle_45",
      falRequestId: "req-45",
    });

    const assets = await db.getAssets(character.id);
    assert.equal(assets.length, 2);
    const master = assets.find((a) => a.kind === "master");
    assert.ok(master);
    assert.deepEqual(master.meta, { model: "openai/gpt-image-2", seed: 42 });
    assert.equal(master.url, "https://fal.media/master.png");

    const angle = assets.find((a) => a.kind === "angle_45");
    assert.ok(angle);
    assert.equal(angle.meta, null);
    assert.equal(angle.url, null);

    assert.deepEqual(await db.getAssets("no-such-character"), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings set/get with upsert on conflict", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    assert.equal(await db.getSetting("apiKey"), null);
    await db.setSetting("apiKey", "first");
    assert.equal(await db.getSetting("apiKey"), "first");
    await db.setSetting("apiKey", "second");
    assert.equal(await db.getSetting("apiKey"), "second");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("schema apply is idempotent and data persists across reopen", async () => {
  const { file, dir } = tmpDbFile();
  const db1 = openDatabase(file);
  const created = await db1.insertCharacter({
    identifier: "persist-me",
    name: "Persist",
    profile,
  });
  db1.close();

  // Reopening must not throw (CREATE TABLE IF NOT EXISTS) and must see the data.
  const db2 = openDatabase(file);
  try {
    const found = await db2.getCharacter("persist-me");
    assert.ok(found);
    assert.equal(found.id, created.id);
    const all = await db2.listCharacters();
    assert.equal(all.length, 1);
  } finally {
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCharacters returns newest first (deterministic via explicit createdAt)", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    await db.insertCharacter({ identifier: "one", name: "One", profile, createdAt: 1000 });
    await db.insertCharacter({ identifier: "two", name: "Two", profile, createdAt: 2000 });
    const all = await db.listCharacters();
    assert.deepEqual(
      all.map((c) => c.identifier),
      ["two", "one"],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCharacters breaks same-millisecond ties by insertion order (rowid)", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    await db.insertCharacter({ identifier: "first", name: "First", profile, createdAt: 5000 });
    await db.insertCharacter({ identifier: "second", name: "Second", profile, createdAt: 5000 });
    const all = await db.listCharacters();
    assert.deepEqual(
      all.map((c) => c.identifier),
      ["second", "first"],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate identifier insert rejects with a UNIQUE constraint error", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    await db.insertCharacter({ identifier: "isolde-keeper", name: "Isolde", profile });
    await assert.rejects(
      () => db.insertCharacter({ identifier: "isolde-keeper", name: "Clone", profile }),
      (err) => {
        assert.match(errorChainText(err), /UNIQUE constraint failed/iu);
        return true;
      },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asset insert for a nonexistent character rejects with a FK violation", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    // Proves PRAGMA foreign_keys=ON took effect through Drizzle on this connection.
    await assert.rejects(
      () => db.insertAsset({ characterId: "ghost", kind: "master" }),
      (err) => {
        assert.match(errorChainText(err), /FOREIGN KEY constraint failed/iu);
        return true;
      },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCharacter on a nonexistent id returns null", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    const result = await db.updateCharacter("no-such-id", { name: "Nobody" });
    assert.equal(result, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
