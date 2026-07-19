import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openDatabase, parseGalleryData } from "@character-gen/engine";
import type { AngleGenerator, Database } from "@character-gen/engine";
import { cmdTurnaround } from "./pipeline.ts";

/** An angle generator that always fails (offline). */
const failingGenerator: AngleGenerator = {
  angle: () => Promise.reject(new Error("angle boom")),
};

async function seedCharacter(dir: string, withMaster: boolean): Promise<void> {
  const db: Database = openDatabase(join(dir, "db.sqlite"));
  const character = await db.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: { name: "Isolde", identifier: "isolde-keeper" },
  });
  if (withMaster) {
    await db.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: "https://fal.media/master.png",
    });
  }
  db.close();
}

test("turnaround without a master exits 1 pointing at the sheet command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-turn-cli-"));
  try {
    await seedCharacter(dir, false);
    const code = await cmdTurnaround(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: failingGenerator,
    });
    assert.equal(code, 1);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("isolde-keeper");
      // Preconditions failed before the step started, so it never left pending.
      assert.equal(character?.status.turnaround, "pending");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed turnaround run flips the step to error in a live gallery's data.js", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-turn-cli-"));
  try {
    await seedCharacter(dir, true);
    // A previously opened gallery (index.html present so no dist is needed).
    const galleryDir = join(dir, "gallery");
    mkdirSync(galleryDir, { recursive: true });
    writeFileSync(join(galleryDir, "index.html"), "<!doctype html><title>seeded</title>");

    const code = await cmdTurnaround(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: failingGenerator,
    });
    assert.equal(code, 1);

    const sandbox: { window: { CHARGEN_DATA?: unknown } } = { window: {} };
    runInNewContext(readFileSync(join(galleryDir, "data.js"), "utf8"), sandbox);
    const data = parseGalleryData(sandbox.window.CHARGEN_DATA);
    assert.ok(data);
    assert.equal(data.characters[0]?.status.turnaround, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful turnaround records the 12 frames through the CLI seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-turn-cli-"));
  try {
    await seedCharacter(dir, true);
    // cmdTurnaround has no fetch seam; a data: URL lets the engine's real
    // download path run offline.
    const okGenerator: AngleGenerator = {
      angle: (input) =>
        Promise.resolve({
          requestId: `req-${input.horizontalAngle}`,
          url: `data:image/png;base64,iVBORw0KGgo=`,
        }),
    };
    const code = await cmdTurnaround(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: okGenerator,
    });
    assert.equal(code, 0);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("isolde-keeper");
      assert.ok(character);
      assert.equal(character.status.turnaround, "done");
      const assets = await db.getAssets(character.id);
      const angles = assets.filter((a) => a.kind.startsWith("angle_"));
      assert.equal(angles.length, 12);
      assert.ok(angles.every((a) => a.localPath !== null));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
