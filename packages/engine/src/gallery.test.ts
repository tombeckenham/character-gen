// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openDatabase } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import type { CharacterRecord } from "./types.ts";
import { GALLERY_NOT_BUILT, refreshGalleryIfPresent, writeGallery } from "./gallery.ts";
import { parseGalleryData } from "./gallery-data.ts";
import type { GalleryData } from "./gallery-data.ts";

interface Ctx {
  dir: string;
  db: Database;
  galleryDir: string;
  spaHtmlPath: string;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), "chargen-gallery-"));
  const spaHtmlPath = join(dir, "spa-index.html");
  writeFileSync(spaHtmlPath, "<!doctype html><title>spa</title>");
  return {
    dir,
    db: openDatabase(join(dir, "db.sqlite")),
    galleryDir: join(dir, "gallery"),
    spaHtmlPath,
  };
}

function teardown(ctx: Ctx): void {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

/** Seeds a character with a downloaded master and returns it. */
async function seedCharacter(ctx: Ctx, identifier = "isolde-keeper"): Promise<CharacterRecord> {
  const character = await ctx.db.insertCharacter({
    identifier,
    name: "Isolde",
    profile: {
      name: "Isolde",
      identifier,
      archetype: "lighthouse keeper",
      visualCanon: "silver braid, oilskin coat",
    },
  });
  const mediaDir = join(ctx.dir, "media", identifier);
  mkdirSync(mediaDir, { recursive: true });
  const file = join(mediaDir, "master-1.png");
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await ctx.db.insertAsset({
    characterId: character.id,
    kind: "master",
    falRequestId: "req-master",
    url: "https://fal.media/master.png",
    localPath: file,
  });
  return character;
}

/** Executes data.js exactly like the browser would (fresh `window`), then runs
 * it through the SPA-side parser — the contract round-trip. */
function readDataJs(galleryDir: string): GalleryData {
  const source = readFileSync(join(galleryDir, "data.js"), "utf8");
  const sandbox: { window: { CHARGEN_DATA?: unknown } } = { window: {} };
  runInNewContext(source, sandbox);
  const parsed = parseGalleryData(sandbox.window.CHARGEN_DATA);
  assert.ok(parsed, "data.js payload must survive the SPA-side parse");
  return parsed;
}

test("writeGallery writes index.html, media copies, and a parseable data.js", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    const result = await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });

    assert.equal(readFileSync(result.indexHtml, "utf8"), "<!doctype html><title>spa</title>");
    assert.ok(existsSync(join(ctx.galleryDir, "media", "isolde-keeper", "master-1.png")));

    const data = readDataJs(ctx.galleryDir);
    assert.equal(data.version, 1);
    assert.equal(result.version, 1);
    const character = data.characters[0];
    assert.ok(character);
    assert.equal(character.identifier, "isolde-keeper");
    assert.equal(character.name, "Isolde");
    assert.equal(character.archetype, "lighthouse keeper");
    assert.equal(character.visualCanon, "silver braid, oilskin coat");
    assert.equal(character.status.profile, "pending");
    assert.deepEqual(character.assets, [
      { kind: "master", path: "media/isolde-keeper/master-1.png" },
    ]);
  } finally {
    teardown(ctx);
  }
});

test("writeGallery skips assets with a null local_path (failed downloads)", async () => {
  const ctx = setup();
  try {
    const character = await seedCharacter(ctx);
    await ctx.db.insertAsset({
      characterId: character.id,
      kind: "expression",
      falRequestId: "req-expr",
      url: "https://fal.media/expr.png",
      localPath: null,
    });
    await writeGallery({ db: ctx.db, galleryDir: ctx.galleryDir, spaHtmlPath: ctx.spaHtmlPath });
    const data = readDataJs(ctx.galleryDir);
    assert.deepEqual(
      data.characters[0]?.assets.map((a) => a.kind),
      ["master"],
    );
  } finally {
    teardown(ctx);
  }
});

test("writeGallery skips (with a warning) assets whose local file vanished", async () => {
  const ctx = setup();
  try {
    const character = await seedCharacter(ctx);
    const ghost = join(ctx.dir, "media", "isolde-keeper", "gone.png");
    await ctx.db.insertAsset({ characterId: character.id, kind: "outfit", localPath: ghost });
    const warnings: string[] = [];
    await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
      onWarn: (m) => warnings.push(m),
    });
    const data = readDataJs(ctx.galleryDir);
    assert.deepEqual(
      data.characters[0]?.assets.map((a) => a.kind),
      ["master"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /outfit.*gone\.png/u);
  } finally {
    teardown(ctx);
  }
});

test("version strictly increases across runs and across database reopens", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    const first = await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });
    const second = await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);

    // A separate CLI invocation = a fresh database handle.
    ctx.db.close();
    ctx.db = openDatabase(join(ctx.dir, "db.sqlite"));
    const third = await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });
    assert.equal(third.version, 3);
    assert.equal(readDataJs(ctx.galleryDir).version, 3);
  } finally {
    teardown(ctx);
  }
});

test("data.js is written atomically: replaced in place, no tmp files left over", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    mkdirSync(ctx.galleryDir, { recursive: true });
    writeFileSync(join(ctx.galleryDir, "data.js"), "window.CHARGEN_DATA = { stale: true };");
    await writeGallery({ db: ctx.db, galleryDir: ctx.galleryDir, spaHtmlPath: ctx.spaHtmlPath });
    // The stale file was replaced wholesale (rename, not append/truncate)...
    const data = readDataJs(ctx.galleryDir);
    assert.equal(data.version, 1);
    // ...and no temp artifacts remain for the polling page to trip over.
    const leftovers = readdirSync(ctx.galleryDir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    teardown(ctx);
  }
});

test("media copies are idempotent across runs", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery({ db: ctx.db, galleryDir: ctx.galleryDir, spaHtmlPath: ctx.spaHtmlPath });
    await writeGallery({ db: ctx.db, galleryDir: ctx.galleryDir, spaHtmlPath: ctx.spaHtmlPath });
    const files = readdirSync(join(ctx.galleryDir, "media", "isolde-keeper"));
    assert.deepEqual(files, ["master-1.png"]);
    assert.deepEqual(
      readFileSync(join(ctx.galleryDir, "media", "isolde-keeper", "master-1.png")),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  } finally {
    teardown(ctx);
  }
});

test("writeGallery without a built SPA and no prior index.html throws GALLERY_NOT_BUILT", async () => {
  const ctx = setup();
  try {
    await assert.rejects(
      writeGallery({
        db: ctx.db,
        galleryDir: ctx.galleryDir,
        spaHtmlPath: join(ctx.dir, "no-such-dist.html"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, GALLERY_NOT_BUILT);
        assert.match(error.message, /bun run build:gallery/u);
        return true;
      },
    );
  } finally {
    teardown(ctx);
  }
});

test("writeGallery keeps an existing index.html when the built SPA is missing", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    mkdirSync(ctx.galleryDir, { recursive: true });
    writeFileSync(join(ctx.galleryDir, "index.html"), "<!doctype html><title>previous</title>");
    const result = await writeGallery({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: join(ctx.dir, "no-such-dist.html"),
    });
    assert.equal(readFileSync(result.indexHtml, "utf8"), "<!doctype html><title>previous</title>");
    assert.equal(readDataJs(ctx.galleryDir).version, 1);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent is a no-op when the gallery was never opened", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await refreshGalleryIfPresent({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });
    assert.equal(existsSync(ctx.galleryDir), false);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent rewrites an existing gallery", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery({ db: ctx.db, galleryDir: ctx.galleryDir, spaHtmlPath: ctx.spaHtmlPath });
    await refreshGalleryIfPresent({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: ctx.spaHtmlPath,
    });
    assert.equal(readDataJs(ctx.galleryDir).version, 2);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent never throws — a failure warns instead", async () => {
  const ctx = setup();
  try {
    // Gallery dir exists but is unusable: no index.html and no built SPA.
    mkdirSync(ctx.galleryDir, { recursive: true });
    const warnings: string[] = [];
    await refreshGalleryIfPresent({
      db: ctx.db,
      galleryDir: ctx.galleryDir,
      spaHtmlPath: join(ctx.dir, "no-such-dist.html"),
      onWarn: (m) => warnings.push(m),
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /gallery refresh failed/u);
  } finally {
    teardown(ctx);
  }
});
