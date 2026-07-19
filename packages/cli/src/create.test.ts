import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@character-gen/engine";
import type { AngleGenerator, ImageGenerator } from "@character-gen/engine";
import { cmdCreate } from "./create.ts";

const failingImageGenerator: ImageGenerator = {
  generate: () => Promise.reject(new Error("master boom")),
  edit: () => Promise.reject(new Error("edit boom")),
};

test("a failed sheet short-circuits the turnaround: no angle generation is ever attempted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-create-cli-"));
  try {
    const profileFile = join(dir, "profile.json");
    writeFileSync(profileFile, JSON.stringify({ name: "Isolde", identifier: "isolde-keeper" }));
    let angleCalls = 0;
    const angleGenerator: AngleGenerator = {
      angle: () => {
        angleCalls += 1;
        return Promise.reject(new Error("must never be called"));
      },
    };

    const code = await cmdCreate(
      ["--profile-json", profileFile, "--steps", "profile,sheet,turnaround"],
      {
        env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
        imageGenerator: failingImageGenerator,
        angleGenerator,
      },
    );

    assert.equal(code, 1);
    assert.equal(angleCalls, 0, "turnaround must not run (and bill) after a failed sheet");
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("isolde-keeper");
      assert.equal(character?.status.sheet, "error");
      assert.equal(character?.status.turnaround, "pending");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with working generators create runs sheet then turnaround to done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-create-cli-"));
  try {
    const profileFile = join(dir, "profile.json");
    writeFileSync(profileFile, JSON.stringify({ name: "Isolde", identifier: "isolde-keeper" }));
    // data: URLs let the engine's real download path run offline.
    const pngData = "data:image/png;base64,iVBORw0KGgo=";
    const imageGenerator: ImageGenerator = {
      generate: () => Promise.resolve({ requestId: "req-master", url: pngData }),
      edit: () => Promise.resolve({ requestId: "req-edit", url: pngData }),
    };
    const angleGenerator: AngleGenerator = {
      angle: (input) =>
        Promise.resolve({ requestId: `req-${input.horizontalAngle}`, url: pngData }),
    };

    const code = await cmdCreate(
      ["--profile-json", profileFile, "--steps", "profile,sheet,turnaround"],
      {
        env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
        imageGenerator,
        angleGenerator,
      },
    );

    assert.equal(code, 0);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("isolde-keeper");
      assert.equal(character?.status.sheet, "done");
      assert.equal(character?.status.turnaround, "done");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
