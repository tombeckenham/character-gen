// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/index.ts";
import type { CharacterStore } from "../store/index.ts";
import type { CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import { TURNAROUND_ANGLES } from "../types.ts";
import { findMasterUrl, makeFalAngleGenerator, runTurnaround } from "./turnaround.ts";
import type { AngleGenerator, AngleGenInput } from "./turnaround.ts";
import type { GeneratedAsset } from "./common.ts";

const MASTER_URL = "https://fal.media/master.png";

/** A scriptable fake AngleGenerator that records calls and can be told to fail
 * at a specific call index. */
function fakeGenerator(options: { failIndex?: number } = {}): {
  generator: AngleGenerator;
  calls: AngleGenInput[];
} {
  const calls: AngleGenInput[] = [];
  const generator: AngleGenerator = {
    angle(input, onProgress): Promise<GeneratedAsset> {
      const index = calls.length;
      calls.push(input);
      if (options.failIndex === index) {
        return Promise.reject(new Error(`angle ${input.horizontalAngle} boom`));
      }
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: `req-angle-${input.horizontalAngle}`,
        url: `https://fal.media/angle-${input.horizontalAngle}.png`,
      });
    },
  };
  return { generator, calls };
}

/** A fetch that returns tiny PNG bytes for any URL, or a 404 for listed URLs. */
function fakeFetch(notFound: Set<string> = new Set()): FetchImpl {
  return ((url: string | URL | Request) => {
    const href = String(url);
    if (notFound.has(href)) return Promise.resolve(new Response("nope", { status: 404 }));
    return Promise.resolve(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }));
  }) as unknown as FetchImpl;
}

function setup(): { store: CharacterStore; dir: string; charactersDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-turnaround-"));
  return {
    store: openStore(join(dir, "characters"), { onWarn: () => {} }),
    dir,
    charactersDir: join(dir, "characters"),
  };
}

async function seedCharacter(store: CharacterStore, withMaster = true): Promise<CharacterRecord> {
  const character = await store.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: { name: "Isolde", identifier: "isolde-keeper" },
  });
  if (withMaster) {
    await store.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: MASTER_URL,
      localPath: "/tmp/master-1.png",
    });
  }
  return character;
}

// oxlint-disable-next-line max-lines-per-function
test("runTurnaround generates all 12 angles from the master and records assets in order", async () => {
  const { store, dir, charactersDir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator, calls } = fakeGenerator();
    const messages: string[] = [];

    const outcome = await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      onProgress: (m) => messages.push(m),
    });

    assert.deepEqual(
      calls.map((c) => c.horizontalAngle),
      [...TURNAROUND_ANGLES],
    );
    assert.ok(calls.every((c) => c.imageUrl === MASTER_URL));

    assert.equal(outcome.frames.length, 12);
    assert.deepEqual(
      outcome.frames.map((f) => f.kind),
      TURNAROUND_ANGLES.map((angle) => `angle_${angle}`),
    );
    assert.equal(outcome.frames[0]?.falRequestId, "req-angle-0");
    assert.equal(outcome.frames[11]?.falRequestId, "req-angle-330");

    // Files landed under media/<identifier>/ and meta records the angle.
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "angle-0.png")));
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "angle-330.png")));
    assert.equal(outcome.frames[1]?.meta?.["horizontalAngle"], 30);
    assert.equal(
      outcome.frames[1]?.meta?.["endpoint"],
      "fal-ai/qwen-image-edit-2511-multiple-angles",
    );

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "done");
    assert.ok(messages.some((m) => m.includes("angle 0°")));
    assert.ok(messages.includes("turnaround: done"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround accepts an angle subset (cheap test runs)", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator, calls } = fakeGenerator();

    const outcome = await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      angles: [90, 270],
    });

    assert.deepEqual(
      calls.map((c) => c.horizontalAngle),
      [90, 270],
    );
    assert.deepEqual(
      outcome.frames.map((f) => f.kind),
      ["angle_90", "angle_270"],
    );
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround reports each stored frame through onFrame as it lands", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator();
    const seen: string[] = [];

    await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      angles: [0, 45, 90],
      onFrame: (frame) => {
        seen.push(frame.kind);
      },
    });

    assert.deepEqual(seen, ["angle_0", "angle_45", "angle_90"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround survives a throwing onFrame sink: all frames land, warning reported", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator();
    const messages: string[] = [];

    const outcome = await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      angles: [0, 45, 90],
      onProgress: (m) => messages.push(m),
      onFrame: () => Promise.reject(new Error("sink boom")),
    });

    assert.equal(outcome.frames.length, 3);
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "done");
    assert.equal(messages.filter((m) => /frame notification failed: sink boom/u.test(m)).length, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround generates a caller-supplied angle list in its given order", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator, calls } = fakeGenerator();
    const outcome = await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      angles: [180, 0, 90],
    });
    assert.deepEqual(
      calls.map((c) => c.horizontalAngle),
      [180, 0, 90],
    );
    assert.deepEqual(
      outcome.frames.map((f) => f.kind),
      ["angle_180", "angle_0", "angle_90"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing error-status write is warned about and the work error still surfaces", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    // The status DB dies exactly when the step tries to record its failure.
    const flakyDb: CharacterStore = {
      ...store,
      setStepState: (id, step, state) =>
        state === "error"
          ? Promise.reject(new Error("status store down"))
          : store.setStepState(id, step, state),
    };
    const { generator } = fakeGenerator({ failIndex: 0 });
    const messages: string[] = [];

    await assert.rejects(
      () =>
        runTurnaround(character, {
          store: flakyDb,
          generator,
          fetchImpl: fakeFetch(),
          angles: [0],
          onProgress: (m) => messages.push(m),
        }),
      /angle 0 boom/u,
    );

    assert.ok(messages.some((m) => /could not mark turnaround failed: status store down/u.test(m)));
    // The error write never landed, so the step is still marked running.
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "running");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing done-status write surfaces as the step error with frames intact", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const flakyDb: CharacterStore = {
      ...store,
      setStepState: (id, step, state) =>
        state === "done"
          ? Promise.reject(new Error("done write down"))
          : store.setStepState(id, step, state),
    };
    const { generator } = fakeGenerator();

    await assert.rejects(
      () =>
        runTurnaround(character, {
          store: flakyDb,
          generator,
          fetchImpl: fakeFetch(),
          angles: [0, 45],
        }),
      /done write down/u,
    );

    // The work itself succeeded — frames and request_ids are all recorded —
    // but the step reads as error because its completion could not be saved.
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "error");
    const stored = await store.getAssets(character.id);
    assert.deepEqual(
      stored.filter((a) => a.kind.startsWith("angle_")).map((a) => a.falRequestId),
      ["req-angle-0", "req-angle-45"],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround without a master errors clearly, runs nothing, keeps status pending", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store, false);
    const { generator, calls } = fakeGenerator();

    await assert.rejects(
      () => runTurnaround(character, { store, generator, fetchImpl: fakeFetch() }),
      /No master image found.*character-gen sheet isolde-keeper/u,
    );

    assert.equal(calls.length, 0);
    const refreshed = await store.getCharacter(character.id);
    // Nothing ran, so the step must not be marked running or error.
    assert.equal(refreshed?.status.turnaround, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround treats a master row without a URL as missing", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store, false);
    await store.insertAsset({ characterId: character.id, kind: "master", falRequestId: "req-m" });
    const { generator } = fakeGenerator();
    await assert.rejects(
      () => runTurnaround(character, { store, generator, fetchImpl: fakeFetch() }),
      /No master image found/u,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround shoots from the newest master when the sheet was re-run", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    await store.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master-2",
      url: "https://fal.media/master-2.png",
    });
    const { generator, calls } = fakeGenerator();
    await runTurnaround(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      angles: [0],
    });
    assert.equal(calls[0]?.imageUrl, "https://fal.media/master-2.png");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround on a mid-sequence failure keeps earlier frames and marks error", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator({ failIndex: 2 });

    await assert.rejects(
      () =>
        runTurnaround(character, {
          store,
          generator,
          fetchImpl: fakeFetch(),
          angles: [0, 45, 90, 135],
        }),
      /angle 90 boom/u,
    );

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "error");

    // The clean prefix of completed frames survives, request_ids intact.
    const stored = await store.getAssets(character.id);
    const frames = stored.filter((a) => a.kind.startsWith("angle_"));
    assert.deepEqual(
      frames.map((f) => [f.kind, f.falRequestId]),
      [
        ["angle_0", "req-angle-0"],
        ["angle_45", "req-angle-45"],
      ],
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround persists the request_id when a frame download fails (row survives, path null)", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator();
    const fetchImpl = fakeFetch(new Set(["https://fal.media/angle-45.png"]));

    await assert.rejects(
      () =>
        runTurnaround(character, {
          store,
          generator,
          fetchImpl,
          angles: [0, 45, 90],
        }),
      /Failed to download image \(HTTP 404\)/u,
    );

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.turnaround, "error");

    const stored = await store.getAssets(character.id);
    const angle0 = stored.find((a) => a.kind === "angle_0");
    const angle45 = stored.find((a) => a.kind === "angle_45");
    assert.ok(angle0?.localPath, "first frame downloaded and has a path");
    assert.equal(angle45?.falRequestId, "req-angle-45");
    assert.equal(angle45?.localPath, null);
    assert.equal(
      stored.some((a) => a.kind === "angle_90"),
      false,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTurnaround refuses an invalid identifier before any generation", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const hostile = { ...character, identifier: "../escape" };
    const { generator, calls } = fakeGenerator();
    await assert.rejects(
      () => runTurnaround(hostile, { store, generator, fetchImpl: fakeFetch() }),
      /invalid identifier/u,
    );
    assert.equal(calls.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMasterUrl returns null when no master asset has a URL", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store, false);
    assert.equal(await findMasterUrl(store, character.id), null);
    await store.insertAsset({
      characterId: character.id,
      kind: "expression",
      url: "https://x/y.png",
    });
    assert.equal(await findMasterUrl(store, character.id), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeFalAngleGenerator conforms to the multiple-angles schema", async () => {
  const subscribeCalls: Array<{ endpoint: string; input: unknown }> = [];
  const fakeClient = {
    subscribe(endpoint: string, options: { input: unknown }) {
      subscribeCalls.push({ endpoint, input: options.input });
      return Promise.resolve({
        requestId: "req-abc",
        data: { prompt: "auto", seed: 7, images: [{ url: "https://fal.media/out.png" }] },
      });
    },
  } as unknown as Parameters<typeof makeFalAngleGenerator>[0];

  const generator = makeFalAngleGenerator(fakeClient);
  const image = await generator.angle({ imageUrl: MASTER_URL, horizontalAngle: 135 });

  assert.equal(image.requestId, "req-abc");
  assert.equal(image.url, "https://fal.media/out.png");
  assert.equal(subscribeCalls[0]?.endpoint, "fal-ai/qwen-image-edit-2511-multiple-angles");
  assert.deepEqual(subscribeCalls[0]?.input, {
    image_urls: [MASTER_URL],
    horizontal_angle: 135,
  });
});

test("makeFalAngleGenerator throws when the response has no image URL", async () => {
  const fakeClient = {
    subscribe() {
      return Promise.resolve({ requestId: "req-x", data: { images: [] } });
    },
  } as unknown as Parameters<typeof makeFalAngleGenerator>[0];
  const generator = makeFalAngleGenerator(fakeClient);
  await assert.rejects(
    () => generator.angle({ imageUrl: MASTER_URL, horizontalAngle: 0 }),
    /no image URL/u,
  );
});
