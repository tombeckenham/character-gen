import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/index.ts";
import type { Database } from "../db/index.ts";
import type { CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import { buildMasterPrompt, buildOutfitPrompt, makeFalImageGenerator, runSheet } from "./sheet.ts";
import type { GeneratedImage, ImageEditInput, ImageGenerator, ImageGenInput } from "./sheet.ts";

interface GenCall {
  op: "generate" | "edit";
  input: ImageGenInput | ImageEditInput;
}

/** A scriptable fake ImageGenerator that records calls and can be told to fail
 * a specific call index. */
function fakeGenerator(options: { failEditIndex?: number } = {}): {
  generator: ImageGenerator;
  calls: GenCall[];
} {
  const calls: GenCall[] = [];
  let editCount = 0;
  const generator: ImageGenerator = {
    generate(input, onProgress): Promise<GeneratedImage> {
      calls.push({ op: "generate", input });
      onProgress?.({ status: "IN_PROGRESS" });
      return Promise.resolve({ requestId: "req-master", url: "https://fal.media/master.png" });
    },
    edit(input, onProgress): Promise<GeneratedImage> {
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

function setup(): { db: Database; dir: string; mediaDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-sheet-"));
  return { db: openDatabase(join(dir, "db.sqlite")), dir, mediaDir: join(dir, "media") };
}

function seedCharacter(db: Database): Promise<CharacterRecord> {
  return db.insertCharacter({
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

// oxlint-disable-next-line max-lines-per-function
test("runSheet generates master + variants, writes files, and records assets", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedCharacter(db);
    const { generator, calls } = fakeGenerator();
    const messages: string[] = [];

    const outcome = await runSheet(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch(),
      onProgress: (m) => messages.push(m),
    });

    // One text-to-image master + two edits (expression, outfit).
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.op, "generate");
    assert.equal(calls[1]?.op, "edit");
    assert.equal(calls[2]?.op, "edit");
    // Edits reference the master image URL.
    const firstEdit = calls[1];
    assert.ok(firstEdit);
    assert.deepEqual((firstEdit.input as ImageEditInput).imageUrls, [
      "https://fal.media/master.png",
    ]);

    // Outcome + DB rows carry the fal request ids.
    assert.equal(outcome.master.kind, "master");
    assert.equal(outcome.master.falRequestId, "req-master");
    assert.equal(outcome.variants.length, 2);
    assert.deepEqual(
      outcome.variants.map((v) => v.kind),
      ["expression", "outfit"],
    );

    const stored = await db.getAssets(character.id);
    assert.equal(stored.length, 3);
    assert.deepEqual(stored.map((a) => a.falRequestId).toSorted(), [
      "req-edit-0",
      "req-edit-1",
      "req-master",
    ]);

    // Files landed under media/<identifier>/ and hold the downloaded bytes.
    const masterPath = join(mediaDir, "isolde-keeper", "master-1.png");
    assert.ok(existsSync(masterPath));
    assert.equal(readFileSync(masterPath).length, 4);
    assert.ok(existsSync(join(mediaDir, "isolde-keeper", "expression-1.png")));
    assert.ok(existsSync(join(mediaDir, "isolde-keeper", "outfit-1.png")));
    assert.equal(outcome.master.localPath, masterPath);

    // Master meta records the exact prompt and endpoint.
    assert.equal(outcome.master.meta?.["endpoint"], "openai/gpt-image-2");
    assert.equal(outcome.master.meta?.["prompt"], buildMasterPrompt(character.profile));

    // Status moved to done and progress was reported.
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "done");
    assert.ok(messages.some((m) => m.includes("master")));
    assert.ok(messages.includes("sheet: done"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet marks the step done and preserves the profile step", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const created = await db.insertCharacter({
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
    await runSheet(created, { db, generator, mediaDir, fetchImpl: fakeFetch() });
    const refreshed = await db.getCharacter(created.id);
    assert.equal(refreshed?.status.profile, "done");
    assert.equal(refreshed?.status.sheet, "done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet on a fal failure sets status error and keeps prior assets", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedCharacter(db);
    // Fail the second edit (the outfit); master + expression should survive.
    const { generator } = fakeGenerator({ failEditIndex: 1 });

    await assert.rejects(
      () => runSheet(character, { db, generator, mediaDir, fetchImpl: fakeFetch() }),
      /edit 1 boom/u,
    );

    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");

    const stored = await db.getAssets(character.id);
    assert.deepEqual(
      stored.map((a) => a.kind),
      ["master", "expression"],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSheet surfaces a download failure and marks the step error", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedCharacter(db);
    const { generator } = fakeGenerator();
    // The master image URL 404s on download.
    const fetchImpl = fakeFetch(new Set(["https://fal.media/master.png"]));

    await assert.rejects(
      () => runSheet(character, { db, generator, mediaDir, fetchImpl }),
      /Failed to download image \(HTTP 404\)/u,
    );

    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.sheet, "error");
    assert.deepEqual(await db.getAssets(character.id), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
