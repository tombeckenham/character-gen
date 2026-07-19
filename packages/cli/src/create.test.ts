import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@character-gen/engine";
import type { AngleGenerator, ImageGenerator, VoiceGenerator } from "@character-gen/engine";
import { cmdCreate } from "./create.ts";

const failingImageGenerator: ImageGenerator = {
  generate: () => Promise.reject(new Error("master boom")),
  edit: () => Promise.reject(new Error("edit boom")),
};

/** These runs never include the voice step, but `create` resolves all step
 * generators together — so injecting one keeps the run offline (no key needed). */
const unusedVoiceGenerator: VoiceGenerator = {
  design: () => Promise.reject(new Error("no voice in this run")),
  speak: () => Promise.reject(new Error("no speak in this run")),
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
        voiceGenerator: unusedVoiceGenerator,
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

// One end-to-end scenario: seeding, counting generators, and DB assertions
// belong to the same run.
// oxlint-disable-next-line max-lines-per-function
test("create --tier rich runs the core sheet then the rich passes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-create-cli-"));
  try {
    const profileFile = join(dir, "profile.json");
    writeFileSync(
      profileFile,
      JSON.stringify({
        name: "Aldous",
        identifier: "aldous-grey",
        visualCanon: "wiry man in an oilskin coat",
        imperfections: [{ what: "scar", where: "brow", story: "gaff hook" }],
      }),
    );
    const pngData = "data:image/png;base64,iVBORw0KGgo=";
    let generates = 0;
    let edits = 0;
    const imageGenerator: ImageGenerator = {
      generate: () => {
        generates += 1;
        return Promise.resolve({ requestId: "req-master", url: pngData });
      },
      edit: () => {
        edits += 1;
        return Promise.resolve({ requestId: `req-edit-${edits}`, url: pngData });
      },
    };

    // Steps passed explicitly: this test is about tier passes, not the
    // (default) turnaround.
    const code = await cmdCreate(
      ["--profile-json", profileFile, "--tier", "rich", "--steps", "profile,sheet"],
      {
        env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
        imageGenerator,
        angleGenerator: {
          angle: () => Promise.reject(new Error("no turnaround in this run")),
        },
        voiceGenerator: unusedVoiceGenerator,
      },
    );

    assert.equal(code, 0);
    // Core: 1 generate + 2 edits. Rich passes: 3 face + 4 default expressions +
    // 2 details (hands + the one imperfection) = 9 more edits — 12 generations.
    assert.equal(generates, 1);
    assert.equal(edits, 11);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("aldous-grey");
      assert.equal(character?.status.sheet, "done");
      const assets = await db.getAssets(character?.id ?? "");
      const kinds = assets.map((asset) => asset.kind);
      for (const kind of ["face_front", "face_three_quarter", "face_profile", "detail"]) {
        assert.ok(kinds.includes(kind as (typeof kinds)[number]), `missing ${kind}`);
      }
      assert.equal(kinds.filter((kind) => kind === "expression").length, 5, "grid + 4 named");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create --tier without the sheet step is refused up front", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-create-cli-"));
  try {
    const profileFile = join(dir, "profile.json");
    writeFileSync(profileFile, JSON.stringify({ name: "X", identifier: "x" }));
    const code = await cmdCreate(
      ["--profile-json", profileFile, "--steps", "profile", "--tier", "rich"],
      {
        env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
        imageGenerator: failingImageGenerator,
        angleGenerator: { angle: () => Promise.reject(new Error("never")) },
      },
    );
    assert.equal(code, 1);
    // Refused before the character was even created.
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      assert.equal(await db.getCharacter("x"), null);
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
        voiceGenerator: unusedVoiceGenerator,
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
