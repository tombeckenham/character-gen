import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/index.ts";
import type { Database } from "../db/index.ts";
import type { AssetRecord, CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import { runSheetPasses, selectDetailSubjects } from "./passes.ts";
import type { GeneratedAsset, ImageEditInput, ImageGenerator } from "./sheet.ts";

/** A scriptable fake ImageGenerator: records edit calls, can fail the Nth. */
function fakeEditor(options: { failEditIndex?: number } = {}): {
  generator: ImageGenerator;
  edits: ImageEditInput[];
} {
  const edits: ImageEditInput[] = [];
  const generator: ImageGenerator = {
    generate(): Promise<GeneratedAsset> {
      return Promise.reject(new Error("passes must never call generate()"));
    },
    edit(input, onProgress): Promise<GeneratedAsset> {
      const index = edits.length;
      edits.push(input);
      if (options.failEditIndex === index) {
        return Promise.reject(new Error(`edit ${index} boom`));
      }
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: `req-pass-${index}`,
        url: `https://fal.media/pass-${index}.png`,
      });
    },
  };
  return { generator, edits };
}

const fakeFetch: FetchImpl = (() =>
  Promise.resolve(
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }),
  )) as unknown as FetchImpl;

function setup(): { db: Database; dir: string; mediaDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-passes-"));
  return { db: openDatabase(join(dir, "db.sqlite")), dir, mediaDir: join(dir, "media") };
}

/** Seeds a rich character WITH a stored master (passes edit from its URL). */
async function seedWithMaster(db: Database): Promise<CharacterRecord> {
  const character = await db.insertCharacter({
    identifier: "aldous-grey",
    name: "Aldous",
    profile: {
      name: "Aldous",
      identifier: "aldous-grey",
      visualCanon: "wiry man in an oilskin coat",
      imperfections: [{ what: "thin white scar", where: "brow", story: "gaff hook winter" }],
      signatureItems: ["brass compass"],
      expressions: ["weathered joy", "cold fury"],
    },
  });
  await db.insertAsset({
    characterId: character.id,
    kind: "master",
    falRequestId: "req-master",
    url: "https://fal.media/master.png",
  });
  return character;
}

test("selectDetailSubjects: hands first, then imperfections, then props, capped", () => {
  const profile = {
    name: "X",
    identifier: "x",
    imperfections: [
      { what: "scar", where: "brow", story: "the winter the boat went down" },
      { what: "chipped tooth", where: "upper left" },
    ],
    signatureItems: ["compass", "oilskin coat"],
  };
  const all = selectDetailSubjects(profile, 10);
  assert.deepEqual(
    all.map((subject) => subject.subject),
    ["hands", "imperfection:0", "imperfection:1", "prop:0", "prop:1"],
  );
  // The story is the caption when present; the phrase otherwise.
  assert.equal(all[1]?.caption, "the winter the boat went down");
  assert.equal(all[2]?.caption, "chipped tooth (upper left)");
  assert.deepEqual(
    selectDetailSubjects(profile, 2).map((subject) => subject.subject),
    ["hands", "imperfection:0"],
  );
});

// oxlint-disable-next-line max-lines-per-function
test("runSheetPasses runs the rich tier: face triptych + named expressions + details", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedWithMaster(db);
    const { generator, edits } = fakeEditor();
    const seen: AssetRecord[] = [];

    const outcome = await runSheetPasses(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch,
      passes: ["face", "expressions", "details"],
      detailCap: 2,
      onAsset: (asset) => {
        seen.push(asset);
      },
    });

    // 3 faces + 2 named expressions + 2 details (hands + the one imperfection).
    assert.equal(outcome.assets.length, 7);
    assert.deepEqual(
      outcome.assets.map((asset) => asset.kind),
      [
        "face_front",
        "face_three_quarter",
        "face_profile",
        "expression",
        "expression",
        "detail",
        "detail",
      ],
    );
    // Every edit shoots from the stored master URL.
    assert.ok(edits.every((input) => input.imageUrls[0] === "https://fal.media/master.png"));
    // The canon is injected into every prompt.
    assert.ok(edits.every((input) => input.prompt.includes("wiry man in an oilskin coat")));
    // Named expressions carry meta.label; details carry subject + caption.
    const labels = outcome.assets
      .filter((asset) => asset.kind === "expression")
      .map((asset) => asset.meta?.["label"]);
    assert.deepEqual(labels, ["weathered joy", "cold fury"]);
    const details = outcome.assets.filter((asset) => asset.kind === "detail");
    assert.deepEqual(
      details.map((asset) => asset.meta?.["subject"]),
      ["hands", "imperfection:0"],
    );
    assert.equal(details[1]?.meta?.["caption"], "gaff hook winter");
    // Files landed and the per-asset notification fired for each.
    assert.ok(outcome.assets.every((asset) => asset.localPath && existsSync(asset.localPath)));
    assert.equal(seen.length, 7);
    // The sheet step rolled up to done.
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheetPasses runs passes independently (scale alone) in canonical order", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedWithMaster(db);
    const { generator, edits } = fakeEditor();
    // Requested out of canonical order; scale still runs last.
    const outcome = await runSheetPasses(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch,
      passes: ["scale", "face"],
    });
    assert.deepEqual(
      outcome.assets.map((asset) => asset.kind),
      ["face_front", "face_three_quarter", "face_profile", "scale"],
    );
    assert.equal(edits.length, 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheetPasses money-guard: a failing shot aborts everything after it", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedWithMaster(db);
    // Fail the last face shot; expressions/details must never generate.
    const { generator, edits } = fakeEditor({ failEditIndex: 2 });

    await assert.rejects(
      () =>
        runSheetPasses(character, {
          db,
          generator,
          mediaDir,
          fetchImpl: fakeFetch,
          passes: ["face", "expressions", "details"],
        }),
      /edit 2 boom/u,
    );

    assert.equal(edits.length, 3, "no shot ran past the failure");
    // The two completed faces survive; the step is marked error.
    const stored = await db.getAssets(character.id);
    assert.deepEqual(
      stored.map((asset) => asset.kind),
      ["master", "face_front", "face_three_quarter"],
    );
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheetPasses without a master refuses before spending anything", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await db.insertCharacter({
      identifier: "no-master",
      name: "Nobody",
      profile: { name: "Nobody", identifier: "no-master" },
    });
    const { generator, edits } = fakeEditor();
    await assert.rejects(
      () =>
        runSheetPasses(character, {
          db,
          generator,
          mediaDir,
          fetchImpl: fakeFetch,
          passes: ["face"],
        }),
      /No master image found/u,
    );
    assert.equal(edits.length, 0);
    // The status was not touched — the guard fires before withStepStatus.
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "pending");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheetPasses survives a throwing onAsset sink", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedWithMaster(db);
    const { generator } = fakeEditor();
    const warnings: string[] = [];
    const outcome = await runSheetPasses(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch,
      passes: ["scale"],
      onProgress: (message) => warnings.push(message),
      onAsset: () => {
        throw new Error("sink boom");
      },
    });
    assert.equal(outcome.assets.length, 1);
    assert.ok(warnings.some((message) => message.includes("asset notification failed")));
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
