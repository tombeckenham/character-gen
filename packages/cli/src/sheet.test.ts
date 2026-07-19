import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openDatabase, parseGalleryData } from "@character-gen/engine";
import type { ImageGenerator } from "@character-gen/engine";
import { cmdSheet } from "./sheet-cmd.ts";

/** A generator whose master generation always fails (offline). */
const failingGenerator: ImageGenerator = {
  generate: () => Promise.reject(new Error("master boom")),
  edit: () => Promise.reject(new Error("edit boom")),
};

test("sheet --tier rich money-guard: a failed core sheet runs zero passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    db.close();
    let edits = 0;
    const generator: ImageGenerator = {
      generate: () => Promise.reject(new Error("master boom")),
      edit: () => {
        edits += 1;
        return Promise.reject(new Error("must never run"));
      },
    };
    const code = await cmdSheet(["isolde-keeper", "--tier", "rich"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator,
    });
    assert.equal(code, 1);
    assert.equal(edits, 0, "no pass may generate (and bill) after a failed core sheet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sheet --passes face reruns just that pass off the existing master", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    const character = await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    const pngData = "data:image/png;base64,iVBORw0KGgo=";
    await db.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: pngData,
    });
    db.close();
    let generates = 0;
    const editPrompts: string[] = [];
    const generator: ImageGenerator = {
      generate: () => {
        generates += 1;
        return Promise.reject(new Error("core must not regenerate"));
      },
      edit: (input) => {
        editPrompts.push(input.prompt);
        return Promise.resolve({ requestId: `req-${editPrompts.length}`, url: pngData });
      },
    };
    const code = await cmdSheet(["isolde-keeper", "--passes", "face"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator,
    });
    assert.equal(code, 0);
    assert.equal(generates, 0, "--passes never regenerates the core sheet");
    assert.equal(editPrompts.length, 3, "the face pass is exactly the triptych");
    const reopened = openDatabase(join(dir, "db.sqlite"));
    try {
      const assets = await reopened.getAssets(character.id);
      assert.deepEqual(
        assets.map((asset) => asset.kind),
        ["master", "face_front", "face_three_quarter", "face_profile"],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sheet rejects --tier with --passes, unknown tiers, and unknown passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-cli-"));
  try {
    const deps = {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: failingGenerator,
    };
    assert.equal(await cmdSheet(["x", "--tier", "rich", "--passes", "face"], deps), 1);
    assert.equal(await cmdSheet(["x", "--tier", "deluxe"], deps), 1);
    assert.equal(await cmdSheet(["x", "--passes", "faces"], deps), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed sheet run flips the step to error in a live gallery's data.js", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    db.close();
    // A previously opened gallery (index.html present so no dist is needed).
    const galleryDir = join(dir, "gallery");
    mkdirSync(galleryDir, { recursive: true });
    writeFileSync(join(galleryDir, "index.html"), "<!doctype html><title>seeded</title>");

    const code = await cmdSheet(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: failingGenerator,
    });
    assert.equal(code, 1);

    // The post-run refresh must have published the error state — this is the
    // "chip goes red live" behavior an open page renders on its next tick.
    const sandbox: { window: { CHARGEN_DATA?: unknown } } = { window: {} };
    runInNewContext(readFileSync(join(galleryDir, "data.js"), "utf8"), sandbox);
    const data = parseGalleryData(sandbox.window.CHARGEN_DATA);
    assert.ok(data);
    assert.equal(data.characters[0]?.identifier, "isolde-keeper");
    assert.equal(data.characters[0]?.status.sheet, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
