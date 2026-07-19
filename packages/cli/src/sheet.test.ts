import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openDatabase, parseGalleryData } from "@character-gen/engine";
import type { ImageGenerator } from "@character-gen/engine";
import { cmdSheet } from "./pipeline.ts";

/** A generator whose master generation always fails (offline). */
const failingGenerator: ImageGenerator = {
  generate: () => Promise.reject(new Error("master boom")),
  edit: () => Promise.reject(new Error("edit boom")),
};

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
