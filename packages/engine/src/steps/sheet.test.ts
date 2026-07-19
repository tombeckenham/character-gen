import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/index.ts";
import type { CharacterStore } from "../store/index.ts";
import type { CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import {
  buildMasterPrompt,
  buildOutfitPrompt,
  buildPortraitPrompt,
  makeFalImageGenerator,
  runSheet,
} from "./sheet.ts";
import type { GeneratedAsset, ImageEditInput, ImageGenerator, ImageGenInput } from "./sheet.ts";

interface GenCall {
  op: "generate" | "edit";
  input: ImageGenInput | ImageEditInput;
}

/** A scriptable fake ImageGenerator that records calls and can be told to fail
 * the master generate() or a specific edit index. */
function fakeGenerator(options: { failEditIndex?: number; failGenerate?: boolean } = {}): {
  generator: ImageGenerator;
  calls: GenCall[];
} {
  const calls: GenCall[] = [];
  let editCount = 0;
  const generator: ImageGenerator = {
    generate(input, onProgress): Promise<GeneratedAsset> {
      calls.push({ op: "generate", input });
      if (options.failGenerate) return Promise.reject(new Error("master boom"));
      onProgress?.({ status: "IN_PROGRESS" });
      return Promise.resolve({ requestId: "req-master", url: "https://fal.media/master.png" });
    },
    edit(input, onProgress): Promise<GeneratedAsset> {
      const index = editCount;
      editCount += 1;
      calls.push({ op: "edit", input });
      if (options.failEditIndex === index) {
        return Promise.reject(new Error(`edit ${index} boom`));
      }
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: `req-edit-${index}`,
        url: `https://fal.media/edit-${index}.png`,
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
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-"));
  return {
    store: openStore(join(dir, "characters"), { onWarn: () => {} }),
    dir,
    charactersDir: join(dir, "characters"),
  };
}

function seedCharacter(store: CharacterStore): Promise<CharacterRecord> {
  return store.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: {
      name: "Isolde",
      identifier: "isolde-keeper",
      archetype: "lighthouse keeper",
      visualCanon: "silver braid, oilskin coat",
    },
  });
}

test("runSheet generates master + variants, writes files, and records assets", async () => {
  const { store, dir, charactersDir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator, calls } = fakeGenerator();
    const messages: string[] = [];

    const outcome = await runSheet(character, {
      store,
      generator,
      fetchImpl: fakeFetch(),
      onProgress: (m) => messages.push(m),
    });

    // One text-to-image master + three edits (portrait, expression, outfit).
    assert.equal(calls.length, 4);
    assert.equal(calls[0]?.op, "generate");
    assert.equal(calls[1]?.op, "edit");
    assert.equal(calls[2]?.op, "edit");
    assert.equal(calls[3]?.op, "edit");
    // Edits reference the master image URL.
    const firstEdit = calls[1];
    assert.ok(firstEdit);
    assert.deepEqual((firstEdit.input as ImageEditInput).imageUrls, [
      "https://fal.media/master.png",
    ]);

    // Outcome + DB rows carry the fal request ids.
    assert.equal(outcome.master.kind, "master");
    assert.equal(outcome.master.falRequestId, "req-master");
    assert.equal(outcome.variants.length, 3);
    assert.deepEqual(
      outcome.variants.map((v) => v.kind),
      ["portrait", "expression", "outfit"],
    );

    const stored = await store.getAssets(character.id);
    assert.equal(stored.length, 4);
    assert.deepEqual(stored.map((a) => a.falRequestId).toSorted(), [
      "req-edit-0",
      "req-edit-1",
      "req-edit-2",
      "req-master",
    ]);

    // Files landed under media/<identifier>/ and hold the downloaded bytes.
    const masterPath = join(charactersDir, "isolde-keeper", "master-1.png");
    assert.ok(existsSync(masterPath));
    assert.equal(readFileSync(masterPath).length, 4);
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "portrait-1.png")));
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "expression-1.png")));
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "outfit-1.png")));
    assert.equal(outcome.master.localPath, masterPath);

    // Master meta records the exact prompt and endpoint.
    assert.equal(outcome.master.meta?.["endpoint"], "openai/gpt-image-2");
    assert.equal(outcome.master.meta?.["prompt"], buildMasterPrompt(character.profile));

    // Status moved to done and progress was reported.
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "done");
    assert.ok(messages.some((m) => m.includes("master")));
    assert.ok(messages.includes("sheet: done"));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet marks the step done and preserves the profile step", async () => {
  const { store, dir } = setup();
  try {
    const created = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
      status: {
        profile: "done",
        sheet: "pending",
        turnaround: "pending",
        voice: "pending",
        publish: "pending",
      },
    });
    const { generator } = fakeGenerator();
    await runSheet(created, { store, generator, fetchImpl: fakeFetch() });
    const refreshed = await store.getCharacter(created.id);
    assert.equal(refreshed?.status.profile, "done");
    assert.equal(refreshed?.status.sheet, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet on a fal failure sets status error and keeps prior assets", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    // Fail the outfit edit (index 2); master + portrait + expression should survive.
    const { generator } = fakeGenerator({ failEditIndex: 2 });

    await assert.rejects(
      () => runSheet(character, { store, generator, fetchImpl: fakeFetch() }),
      /edit 2 boom/u,
    );

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");

    const stored = await store.getAssets(character.id);
    assert.deepEqual(stored.map((a) => a.kind).toSorted(), ["expression", "master", "portrait"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet on a master generate failure records zero assets, status error", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator({ failGenerate: true });

    await assert.rejects(
      () => runSheet(character, { store, generator, fetchImpl: fakeFetch() }),
      /master boom/u,
    );

    assert.deepEqual(await store.getAssets(character.id), []);
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet persists the request_id when the download fails (row survives, path null)", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator();
    // The master image generated fine (billed) but its download 404s.
    const fetchImpl = fakeFetch(new Set(["https://fal.media/master.png"]));

    await assert.rejects(
      () => runSheet(character, { store, generator, fetchImpl }),
      /Failed to download image \(HTTP 404\)/u,
    );

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");

    // The row is kept so the billed request_id stays referenceable for publish.
    const stored = await store.getAssets(character.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.kind, "master");
    assert.equal(stored[0]?.falRequestId, "req-master");
    assert.equal(stored[0]?.localPath, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet keeps the failed variant's request_id and the master intact on variant download 404", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const { generator } = fakeGenerator();
    // Master downloads fine; the expression variant (edit index 1) 404s on
    // download while the portrait and outfit variants succeed concurrently.
    const fetchImpl = fakeFetch(new Set(["https://fal.media/edit-1.png"]));

    await assert.rejects(
      () => runSheet(character, { store, generator, fetchImpl }),
      /sheet: 1 of 3 variants failed — expression \(Failed to download image \(HTTP 404\)/u,
    );

    const stored = await store.getAssets(character.id);
    assert.equal(stored.length, 4);
    const master = stored.find((a) => a.kind === "master");
    const expression = stored.find((a) => a.kind === "expression");
    const outfit = stored.find((a) => a.kind === "outfit");
    assert.ok(master?.localPath, "master downloaded and has a path");
    assert.equal(expression?.falRequestId, "req-edit-1");
    assert.equal(expression?.localPath, null);
    assert.ok(outfit?.localPath, "the concurrent outfit variant still downloaded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet persists the running state before generation begins", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    let stateDuringGenerate: string | undefined;
    const generator: ImageGenerator = {
      async generate(): Promise<GeneratedAsset> {
        const refreshed = await store.getCharacter(character.id);
        stateDuringGenerate = refreshed?.status.sheet;
        return { requestId: "req-master", url: "https://fal.media/master.png" };
      },
      edit(): Promise<GeneratedAsset> {
        return Promise.resolve({ requestId: "req-edit", url: "https://fal.media/edit.png" });
      },
    };
    await runSheet(character, { store, generator, fetchImpl: fakeFetch() });
    assert.equal(stateDuringGenerate, "running");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet refuses an invalid identifier before any file work", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedCharacter(store);
    const hostile = { ...character, identifier: "../escape" };
    const { generator, calls } = fakeGenerator();
    await assert.rejects(
      () => runSheet(hostile, { store, generator, fetchImpl: fakeFetch() }),
      /invalid identifier/u,
    );
    assert.equal(calls.length, 0, "no generation attempted for a bad identifier");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeFalImageGenerator throws when the response has no image URL", async () => {
  const fakeClient = {
    subscribe() {
      return Promise.resolve({ requestId: "req-x", data: { images: [] } });
    },
  } as unknown as Parameters<typeof makeFalImageGenerator>[0];
  const generator = makeFalImageGenerator(fakeClient);
  await assert.rejects(() => generator.generate({ prompt: "x" }), /no image URL/u);
});

test("makeFalImageGenerator maps subscribe results and conforms to the schemas", async () => {
  const subscribeCalls: Array<{ endpoint: string; input: unknown }> = [];
  const fakeClient = {
    subscribe(endpoint: string, options: { input: unknown }) {
      subscribeCalls.push({ endpoint, input: options.input });
      return Promise.resolve({
        requestId: "req-xyz",
        data: { images: [{ url: "https://fal.media/out.png" }] },
      });
    },
  } as unknown as Parameters<typeof makeFalImageGenerator>[0];

  const generator = makeFalImageGenerator(fakeClient);

  const master = await generator.generate({ prompt: "hello" });
  assert.equal(master.requestId, "req-xyz");
  assert.equal(master.url, "https://fal.media/out.png");
  assert.equal(subscribeCalls[0]?.endpoint, "openai/gpt-image-2");
  assert.deepEqual(subscribeCalls[0]?.input, {
    prompt: "hello",
    image_size: "portrait_4_3",
    quality: "high",
  });

  const edit = await generator.edit({
    prompt: "same face",
    imageUrls: ["https://fal.media/m.png"],
  });
  assert.equal(edit.url, "https://fal.media/out.png");
  assert.equal(subscribeCalls[1]?.endpoint, "openai/gpt-image-2/edit");
  assert.deepEqual(subscribeCalls[1]?.input, {
    prompt: "same face",
    image_urls: ["https://fal.media/m.png"],
    quality: "high",
  });
});

test("portrait prompt is a close-up that locks identity to the reference", () => {
  const prompt = buildPortraitPrompt({
    name: "Isolde",
    identifier: "isolde-keeper",
    visualCanon: "silver braid, oilskin coat",
  });
  assert.match(prompt, /close-up portrait of Isolde/u);
  assert.match(prompt, /head-and-shoulders/iu);
  assert.match(prompt, /exact same character as the reference/u);
  assert.match(prompt, /silver braid/u);
});

test("outfit prompt omits the archetype clause when absent", () => {
  const withArchetype = buildOutfitPrompt({
    name: "X",
    identifier: "x",
    archetype: "pirate",
  });
  const without = buildOutfitPrompt({ name: "X", identifier: "x" });
  assert.match(withArchetype, /befitting a pirate/u);
  assert.doesNotMatch(without, /befitting/u);
});
