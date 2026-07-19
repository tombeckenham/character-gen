// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** The shared profile re-keyed for another identifier (insertCharacter
 * enforces profile.identifier === identifier). */
function profileFor(identifier: string): CharacterProfile {
  return { ...profile, identifier };
}

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
    profile: profileFor("persist-me"),
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
    await store.insertCharacter({
      identifier: "one",
      name: "One",
      profile: profileFor("one"),
      createdAt: 1000,
    });
    await store.insertCharacter({
      identifier: "two",
      name: "Two",
      profile: profileFor("two"),
      createdAt: 2000,
    });
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
    await store.insertCharacter({
      identifier: "zed",
      name: "Zed",
      profile: profileFor("zed"),
      createdAt: 5000,
    });
    await store.insertCharacter({
      identifier: "abel",
      name: "Abel",
      profile: profileFor("abel"),
      createdAt: 5000,
    });
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
    const created = await store.insertCharacter({
      identifier: "tidy",
      name: "Tidy",
      profile: profileFor("tidy"),
    });
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
  await store.insertCharacter({ identifier: "ok", name: "Ok", profile: profileFor("ok") });
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
  const created = await store.insertCharacter({
    identifier: "norm",
    name: "Norm",
    profile: profileFor("norm"),
  });
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
    await store.insertCharacter({ identifier: "real", name: "Real", profile: profileFor("real") });
    writeFileSync(join(charactersDir, ".DS_Store"), "junk");
    rmSync(join(charactersDir, "real", CHARACTER_FILE));
    const all = await store.listCharacters();
    assert.deepEqual(all, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insertCharacter rejects a profile whose identifier disagrees with the top level", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    await assert.rejects(
      () =>
        store.insertCharacter({
          identifier: "isolde-keeper",
          name: "I",
          profile: profileFor("someone-else"),
        }),
      /profile\.identifier "someone-else" does not match identifier "isolde-keeper"/u,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid JSON in character.json throws an error naming the file", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  await store.insertCharacter({
    identifier: "broken",
    name: "Broken",
    profile: profileFor("broken"),
  });
  writeFileSync(join(charactersDir, "broken", CHARACTER_FILE), '{ "identifier": "broken", <<<<<<<');
  try {
    await assert.rejects(
      () => store.getCharacter("broken"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /invalid JSON in .*broken/u);
        assert.match(err.message, new RegExp(CHARACTER_FILE, "u"));
        return true;
      },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one corrupt neighbor is skipped with a warning; healthy characters keep working", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const warnings: string[] = [];
  const store = openStore(charactersDir, { onWarn: (m) => warnings.push(m) });
  try {
    const healthy = await store.insertCharacter({
      identifier: "healthy",
      name: "Healthy",
      profile: profileFor("healthy"),
    });
    await store.insertCharacter({
      identifier: "broken",
      name: "Broken",
      profile: profileFor("broken"),
    });
    writeFileSync(join(charactersDir, "broken", CHARACTER_FILE), "not json at all");

    // list keeps working and reports the corrupt folder instead of throwing.
    const all = await store.listCharacters();
    assert.deepEqual(
      all.map((c) => c.identifier),
      ["healthy"],
    );
    assert.ok(warnings.some((w) => /skipping broken/u.test(w)));

    // uuid-keyed writes on the healthy character (the billed-request_id path)
    // must survive the corrupt neighbor.
    const asset = await store.insertAsset({
      characterId: healthy.id,
      kind: "master",
      falRequestId: "req-1",
    });
    const patched = await store.setAssetLocalPath(
      asset.id,
      join(charactersDir, "healthy", "master-1.png"),
    );
    assert.equal(patched.falRequestId, "req-1");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a renamed folder whose character.json disagrees fails loudly instead of forking", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  await store.insertCharacter({
    identifier: "old-name",
    name: "Old",
    profile: profileFor("old-name"),
  });
  renameSync(join(charactersDir, "old-name"), join(charactersDir, "new-name"));
  try {
    await assert.rejects(
      () => store.getCharacter("new-name"),
      /says identifier "old-name" but the folder is named "new-name"/u,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setAssetLocalPath stores an in-folder path relative and returns it absolute", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    // The real pipeline inserts with no path and patches it in after download.
    const asset = await store.insertAsset({
      characterId: character.id,
      kind: "master",
      localPath: null,
    });
    const absolute = join(charactersDir, "isolde-keeper", "master-1.png");
    const patched = await store.setAssetLocalPath(asset.id, absolute);
    assert.equal(patched.localPath, absolute);
    const raw = readFileSync(join(charactersDir, "isolde-keeper", CHARACTER_FILE), "utf8");
    const stored = JSON.parse(raw) as { assets: Array<{ localPath: string }> };
    assert.equal(stored.assets[0]?.localPath, "master-1.png");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setAssetLocalPath patches the owning character only, never a neighbor", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    const first = await store.insertCharacter({
      identifier: "first",
      name: "First",
      profile: profileFor("first"),
    });
    const second = await store.insertCharacter({
      identifier: "second",
      name: "Second",
      profile: profileFor("second"),
    });
    await store.insertAsset({ characterId: first.id, kind: "master" });
    const target = await store.insertAsset({ characterId: second.id, kind: "master" });
    const before = readFileSync(join(charactersDir, "first", CHARACTER_FILE), "utf8");

    await store.setAssetLocalPath(target.id, join(charactersDir, "second", "master-1.png"));

    assert.equal(
      (await store.getAssets(second.id))[0]?.localPath,
      join(charactersDir, "second", "master-1.png"),
    );
    assert.equal((await store.getAssets(first.id))[0]?.localPath, null);
    assert.equal(readFileSync(join(charactersDir, "first", CHARACTER_FILE), "utf8"), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an asset path outside the character folder is kept absolute with a warning", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const warnings: string[] = [];
  const store = openStore(charactersDir, { onWarn: (m) => warnings.push(m) });
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile,
    });
    const outside = join(dir, "elsewhere", "master.png");
    await store.insertAsset({ characterId: character.id, kind: "master", localPath: outside });
    assert.equal((await store.getAssets(character.id))[0]?.localPath, outside);
    assert.ok(warnings.some((w) => /not be portable/u.test(w)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a create into an existing json-less folder adopts it and keeps its files", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    mkdirSync(join(charactersDir, "adopted"), { recursive: true });
    writeFileSync(join(charactersDir, "adopted", "stray.png"), "bytes");
    await store.insertCharacter({
      identifier: "adopted",
      name: "Adopted",
      profile: profileFor("adopted"),
    });
    assert.ok(existsSync(join(charactersDir, "adopted", CHARACTER_FILE)));
    assert.equal(readFileSync(join(charactersDir, "adopted", "stray.png"), "utf8"), "bytes");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only operations never create the characters directory", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    assert.deepEqual(await store.listCharacters(), []);
    assert.equal(await store.getCharacter("nobody"), null);
    assert.deepEqual(await store.getAssets("nobody"), []);
    assert.equal(existsSync(charactersDir), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("characterDir returns the media folder and rejects invalid identifiers", async () => {
  const { charactersDir, dir } = tmpCharactersDir();
  const store = openStore(charactersDir);
  try {
    assert.equal(store.characterDir("isolde-keeper"), join(charactersDir, "isolde-keeper"));
    assert.throws(() => store.characterDir("../evil"), /invalid identifier/u);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
