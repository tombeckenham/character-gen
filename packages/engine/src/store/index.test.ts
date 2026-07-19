// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHARACTER_FILE, DuplicateIdentifierError, openStore } from "./index.ts";
import type { CharacterProfile } from "../types.ts";

function tmpCharactersDir(): { charactersDir: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-store-"));
  return { charactersDir: join(dir, "characters"), dir };
}

const profile: CharacterProfile = {
  name: "Isolde the Lighthouse Keeper",
  identifier: "isolde-keeper",
  archetype: "weathered sentinel",
  visualCanon: "silver braid, oilskin coat, lantern-scarred hands",
  voiceDescription: "low, salt-worn, deliberate",
};

test("insert then get a character by id and by identifier, round-tripping JSON", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const created = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde the Lighthouse Keeper",
      profile,
    });
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    const byId = await store.getCharacter(created.id);
    assert.ok(byId);
    assert.equal(byId.identifier, "isolde-keeper");
    assert.deepEqual(byId.profile, profile);
    assert.equal(byId.status.profile, "pending");

    const byIdentifier = await store.getCharacter("isolde-keeper");
    assert.ok(byIdentifier);
    assert.equal(byIdentifier.id, created.id);

    assert.equal(await store.getCharacter("does-not-exist"), null);

    // The character landed as a folder with a character.json inside it.
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", CHARACTER_FILE)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update character status and fal id", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const created = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    const updated = await store.updateCharacter(created.id, {
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
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insert and query assets, round-tripping meta JSON", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    await store.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: "https://fal.media/master.png",
      localPath: "/media/isolde/master.png",
      meta: { model: "openai/gpt-image-2", seed: 42 },
    });
    await store.insertAsset({
      characterId: character.id,
      kind: "angle_45",
      falRequestId: "req-45",
    });

    const assets = await store.getAssets(character.id);
    assert.equal(assets.length, 2);
    const master = assets.find((a) => a.kind === "master");
    assert.ok(master);
    assert.deepEqual(master.meta, { model: "openai/gpt-image-2", seed: 42 });
    assert.equal(master.url, "https://fal.media/master.png");

    const angle = assets.find((a) => a.kind === "angle_45");
    assert.ok(angle);
    assert.equal(angle.meta, null);
    assert.equal(angle.url, null);

    assert.deepEqual(await store.getAssets("no-such-character"), []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a localPath inside the character folder is stored relative, returned absolute", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    const absolute = join(charactersDir, "isolde-keeper", "master-1.png");
    const asset = await store.insertAsset({
      characterId: character.id,
      kind: "master",
      localPath: absolute,
    });
    // The API keeps handing out the absolute path…
    assert.equal(asset.localPath, absolute);
    const fetched = await store.getAssets(character.id);
    assert.equal(fetched[0]?.localPath, absolute);
    // …but the committed character.json stays portable (relative path only).
    const raw = readFileSync(join(charactersDir, "isolde-keeper", CHARACTER_FILE), "utf8");
    const stored = JSON.parse(raw) as { assets: Array<{ localPath: string }> };
    assert.equal(stored.assets[0]?.localPath, "master-1.png");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data persists across store reopens", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store1 = openStore(charactersDir);
  const created = await store1.insertCharacter({
    identifier: "persist-me",
    name: "Persist",
    profile,
  });
  store1.close();

  const store2 = openStore(charactersDir);
  try {
    const found = await store2.getCharacter("persist-me");
    assert.ok(found);
    assert.equal(found.id, created.id);
    const all = await store2.listCharacters();
    assert.equal(all.length, 1);
  } finally {
    store2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCharacters returns newest first (deterministic via explicit createdAt)", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await store.insertCharacter({ identifier: "one", name: "One", profile, createdAt: 1000 });
    await store.insertCharacter({ identifier: "two", name: "Two", profile, createdAt: 2000 });
    const all = await store.listCharacters();
    assert.deepEqual(
      all.map((c) => c.identifier),
      ["two", "one"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listCharacters breaks same-millisecond ties by identifier", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await store.insertCharacter({ identifier: "zed", name: "Zed", profile, createdAt: 5000 });
    await store.insertCharacter({ identifier: "abel", name: "Abel", profile, createdAt: 5000 });
    const all = await store.listCharacters();
    assert.deepEqual(
      all.map((c) => c.identifier),
      ["abel", "zed"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate identifier insert rejects with DuplicateIdentifierError", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await store.insertCharacter({ identifier: "isolde-keeper", name: "Isolde", profile });
    await assert.rejects(
      () => store.insertCharacter({ identifier: "isolde-keeper", name: "Clone", profile }),
      (err) => {
        assert.ok(err instanceof DuplicateIdentifierError);
        assert.match(err.message, /already exists/u);
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insertCharacter refuses a non-slug identifier (path safety)", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await assert.rejects(
      () => store.insertCharacter({ identifier: "../evil", name: "Evil", profile }),
      /invalid identifier/u,
    );
    assert.equal(existsSync(charactersDir), false, "nothing may be written for a bad identifier");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("asset insert for a nonexistent character throws loudly", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await assert.rejects(
      () => store.insertAsset({ characterId: "ghost", kind: "master" }),
      /not found/u,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCharacter on a nonexistent id returns null", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const result = await store.updateCharacter("no-such-id", { name: "Nobody" });
    assert.equal(result, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setStepState updates one step from fresh status and preserves siblings", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const created = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
      status: {
        profile: "done",
        sheet: "pending",
        turnaround: "pending",
        voice: "pending",
        publish: "pending",
      },
    });
    const updated = await store.setStepState(created.id, "sheet", "running");
    assert.equal(updated.status.sheet, "running");
    assert.equal(updated.status.profile, "done", "sibling step preserved");
    const refetched = await store.getCharacter(created.id);
    assert.equal(refetched?.status.sheet, "running");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setStepState from two handles over the same folder never loses a sibling write", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  const other = openStore(charactersDir);
  try {
    const created = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "I",
      profile,
    });
    // Each call reads the file fresh and writes it back synchronously, so two
    // handles in the same process cannot interleave a read-modify-write.
    await Promise.all([
      store.setStepState(created.id, "sheet", "done"),
      other.setStepState(created.id, "turnaround", "running"),
    ]);
    const refreshed = await store.getCharacter(created.id);
    assert.equal(refreshed?.status.sheet, "done");
    assert.equal(refreshed?.status.turnaround, "running");
  } finally {
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setStepState throws loudly for a vanished character (never a silent no-op)", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await assert.rejects(() => store.setStepState("no-such-id", "sheet", "done"), /not found/u);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setAssetLocalPath patches the path and throws for a missing asset", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    const asset = await store.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-1",
      localPath: null,
    });
    const patched = await store.setAssetLocalPath(asset.id, "/media/isolde/master-1.png");
    assert.equal(patched.localPath, "/media/isolde/master-1.png");
    assert.equal(patched.falRequestId, "req-1", "request id preserved");
    await assert.rejects(() => store.setAssetLocalPath("no-such-asset", "/x"), /not found/u);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON writes go through tmp + rename and leave no temp files behind", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const created = await store.insertCharacter({ identifier: "tidy", name: "Tidy", profile });
    await store.setStepState(created.id, "sheet", "done");
    const files = readdirSync(join(charactersDir, "tidy"));
    assert.deepEqual(files, [CHARACTER_FILE]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading a corrupt character.json (blank name/identifier) throws a clear error", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  await store.insertCharacter({ identifier: "ok", name: "Ok", profile });
  // Corrupt the persisted profile out-of-band (blank name/identifier).
  writeFileSync(
    join(charactersDir, "ok", CHARACTER_FILE),
    JSON.stringify({
      id: "x",
      identifier: "ok",
      name: "Ok",
      profile: { name: "", identifier: "" },
      status: {},
      falCharacterId: null,
      createdAt: 1,
      updatedAt: 1,
      assets: [],
    }),
  );
  try {
    await assert.rejects(() => store.getCharacter("ok"), /corrupt profile/u);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial or bogus persisted status normalizes to a full status on read", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  const created = await store.insertCharacter({ identifier: "norm", name: "Norm", profile });
  // Write a status blob missing keys and carrying a bogus value/extra key.
  const file = join(charactersDir, "norm", CHARACTER_FILE);
  const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  stored["status"] = { sheet: "done", bogus: "nope", voice: "weird" };
  writeFileSync(file, JSON.stringify(stored));
  try {
    const found = await store.getCharacter("norm");
    assert.ok(found);
    assert.equal(found.id, created.id);
    assert.deepEqual(found.status, {
      profile: "pending",
      sheet: "done",
      turnaround: "pending",
      // "weird" is not a valid StepState → defaulted back to "pending"
      voice: "pending",
      publish: "pending",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stray file or json-less folder in charactersDir is ignored, not an error", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await store.insertCharacter({ identifier: "real", name: "Real", profile });
    writeFileSync(join(charactersDir, ".DS_Store"), "junk");
    rmSync(join(charactersDir, "real", CHARACTER_FILE));
    const all = await store.listCharacters();
    assert.deepEqual(all, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
