// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/index.ts";
import type { CharacterStore } from "../store/index.ts";
import type { AssetKind, CharacterRecord } from "../types.ts";
import { REFERENCE_IMAGE_CAP } from "../publish-priority.ts";
import { buildPublishDescription, DESCRIPTION_CAP, runPublish } from "./publish.ts";
import type { GenmediaResult } from "./publish.ts";

function setup(): { store: CharacterStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-publish-"));
  return { store: openStore(join(dir, "characters"), { onWarn: () => {} }), dir };
}

function seed(store: CharacterStore): Promise<CharacterRecord> {
  return store.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: {
      name: "Isolde",
      identifier: "isolde-keeper",
      archetype: "weathered lighthouse keeper",
      personality: "patient, salt-worn",
      visualCanon: "silver braid, oilskin coat",
    },
  });
}

/** A scriptable fake genmedia runner that records every argv. */
function fakeRunner(result: Partial<GenmediaResult> = {}): {
  run: (args: string[]) => Promise<GenmediaResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return Promise.resolve({
        status: result.status ?? 0,
        stdout: result.stdout ?? JSON.stringify({ character: { id: "fal-char-123" } }),
        stderr: result.stderr ?? "",
      });
    },
  };
}

async function seedAssets(
  store: CharacterStore,
  characterId: string,
  kinds: readonly AssetKind[],
): Promise<void> {
  for (const [index, kind] of kinds.entries()) {
    // Sequential so request ids follow generation order deterministically.
    // oxlint-disable-next-line no-await-in-loop
    await store.insertAsset({
      characterId,
      kind,
      falRequestId: `req-${index}-${kind}`,
      url: kind === "master" ? "https://fal.media/master.png" : `https://fal.media/${index}.png`,
    });
  }
}

test("first publish creates the fal character and stores the returned id", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    await seedAssets(store, character.id, ["master", "expression"]);
    const runner = fakeRunner();

    const outcome = await runPublish(character, { store, runGenmedia: runner.run });

    assert.equal(outcome.updated, false);
    assert.equal(outcome.falCharacterId, "fal-char-123");
    assert.equal(outcome.referenceCount, 2);

    const args = runner.calls[0];
    assert.ok(args);
    assert.deepEqual(args.slice(0, 4), ["assets", "characters", "create", "Isolde"]);
    assert.equal(args[args.indexOf("--identifier") + 1], "isolde-keeper");
    // Master ranks before the expression in the reference list.
    assert.equal(args[args.indexOf("--reference_image") + 1], "req-0-master,req-1-expression");
    assert.equal(args[args.indexOf("--cover_image_url") + 1], "https://fal.media/master.png");
    assert.equal(args[args.indexOf("--idempotency_key") + 1], `character-gen-${character.id}`);
    assert.ok(args.includes("--json"));
    const description = args[args.indexOf("--description") + 1];
    assert.match(description ?? "", /weathered lighthouse keeper/u);

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.falCharacterId, "fal-char-123");
    assert.equal(refreshed?.status.publish, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-publishing a character with a fal id becomes an update", async () => {
  const { store, dir } = setup();
  try {
    const created = await seed(store);
    await seedAssets(store, created.id, ["master"]);
    await store.updateCharacter(created.id, { falCharacterId: "fal-existing" });
    const character = await store.getCharacter(created.id);
    assert.ok(character);
    const runner = fakeRunner({ stdout: JSON.stringify({ character: { id: "fal-existing" } }) });

    const outcome = await runPublish(character, { store, runGenmedia: runner.run });

    assert.equal(outcome.updated, true);
    const args = runner.calls[0];
    assert.ok(args);
    assert.deepEqual(args.slice(0, 4), ["assets", "characters", "update", "fal-existing"]);
    assert.equal(args[args.indexOf("--name") + 1], "Isolde");
    assert.ok(!args.includes("--identifier"), "update never re-sends the identifier");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("references cap at 20 prioritized images and exclude audio assets", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    const angles: AssetKind[] = [
      "angle_0",
      "angle_30",
      "angle_60",
      "angle_90",
      "angle_120",
      "angle_150",
      "angle_180",
      "angle_210",
      "angle_240",
      "angle_270",
      "angle_300",
      "angle_330",
    ];
    await seedAssets(store, character.id, [
      "master",
      "face_front",
      "face_three_quarter",
      "face_profile",
      "expression",
      "expression",
      "expression",
      "expression",
      "detail",
      "detail",
      "outfit",
      "scale",
      ...angles,
      "voice_sample",
      "speech",
    ]);
    const runner = fakeRunner();

    const outcome = await runPublish(character, { store, runGenmedia: runner.run });

    assert.equal(outcome.referenceCount, REFERENCE_IMAGE_CAP);
    const args = runner.calls[0];
    assert.ok(args);
    const refs = (args[args.indexOf("--reference_image") + 1] ?? "").split(",");
    assert.equal(refs.length, REFERENCE_IMAGE_CAP);
    assert.ok(!refs.some((id) => id.includes("voice") || id.includes("speech")));
    // Faces outrank everything, then the master.
    assert.match(refs[0] ?? "", /face_front/u);
    assert.match(refs[3] ?? "", /master/u);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publishing with no billed image assets fails before touching genmedia", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    await store.insertAsset({
      characterId: character.id,
      kind: "voice_sample",
      falRequestId: "req-v",
    });
    const runner = fakeRunner();

    await assert.rejects(
      () => runPublish(character, { store, runGenmedia: runner.run }),
      /Nothing to publish/u,
    );
    assert.equal(runner.calls.length, 0);
    // The failure happened before the step lifecycle: status untouched.
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.publish, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a genmedia failure marks the publish step error and surfaces stderr", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    await seedAssets(store, character.id, ["master"]);
    const runner = fakeRunner({ status: 1, stdout: "", stderr: "Assets POST failed (401)" });

    await assert.rejects(
      () => runPublish(character, { store, runGenmedia: runner.run }),
      /create failed \(exit 1\): Assets POST failed \(401\)/u,
    );
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.publish, "error");
    assert.equal(refreshed?.falCharacterId, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unparseable genmedia output with no prior fal id is an error, not a silent success", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    await seedAssets(store, character.id, ["master"]);
    const runner = fakeRunner({ stdout: "created ok (not json)" });

    await assert.rejects(
      () => runPublish(character, { store, runGenmedia: runner.run }),
      /returned no character id/u,
    );
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.publish, "error");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPublishDescription distills the profile and caps at 2000 chars", () => {
  assert.equal(
    buildPublishDescription({
      name: "Isolde",
      identifier: "isolde-keeper",
      archetype: "keeper",
      personality: "patient",
      visualCanon: "silver braid",
    }),
    "keeper. patient. silver braid",
  );
  // Falls back to the free-form description, then the name.
  assert.equal(
    buildPublishDescription({ name: "X", identifier: "x", description: "a stray cat" }),
    "a stray cat",
  );
  assert.equal(buildPublishDescription({ name: "Just a Name", identifier: "x" }), "Just a Name");
  const long = buildPublishDescription({
    name: "X",
    identifier: "x",
    visualCanon: "a".repeat(3000),
  });
  assert.equal(long.length, DESCRIPTION_CAP);
  assert.match(long, /…$/u);
});
