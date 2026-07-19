// oxlint-disable max-lines, import/max-dependencies -- exhaustive offline test
// file exercising the whole gallery stack; length and wiring are inherent
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
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openDatabase } from "./db/index.ts";
import type { Database } from "./db/index.ts";
import type { CharacterRecord } from "./types.ts";
import { GALLERY_NOT_BUILT, refreshGalleryIfPresent, writeGallery } from "./gallery.ts";
import type { GalleryWriteDeps } from "./gallery.ts";
import { parseGalleryData } from "./gallery-data.ts";
import type { GalleryData } from "./gallery-data.ts";

const MASTER_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** The content-addressed gallery filename the writer produces for `bytes`. */
function hashedName(stem: string, bytes: Buffer, ext = ".png"): string {
  return `${stem}.${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}${ext}`;
}

interface Ctx {
  dir: string;
  db: Database;
  galleryDir: string;
  spaHtmlPath: string;
  warnings: string[];
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
    warnings: [],
  };
}

/** Standard writer deps for `ctx`, collecting warnings into `ctx.warnings`. */
function deps(ctx: Ctx, overrides: Partial<GalleryWriteDeps> = {}): GalleryWriteDeps {
  return {
    db: ctx.db,
    galleryDir: ctx.galleryDir,
    spaHtmlPath: ctx.spaHtmlPath,
    onWarn: (message) => ctx.warnings.push(message),
    ...overrides,
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
  writeFileSync(file, MASTER_BYTES);
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
    const result = await writeGallery(deps(ctx));

    const masterName = hashedName("master-1", MASTER_BYTES);
    assert.equal(readFileSync(result.indexHtml, "utf8"), "<!doctype html><title>spa</title>");
    assert.ok(existsSync(join(ctx.galleryDir, "media", "isolde-keeper", masterName)));

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
      { kind: "master", path: `media/isolde-keeper/${masterName}` },
    ]);
  } finally {
    teardown(ctx);
  }
});

test("regenerated media gets a new content-addressed name, so an open page re-fetches it", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery(deps(ctx));
    const oldPath = readDataJs(ctx.galleryDir).characters[0]?.assets[0]?.path;
    assert.ok(oldPath);

    // The sheet step regenerated the image in place: same source path, new bytes.
    const newBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]);
    writeFileSync(join(ctx.dir, "media", "isolde-keeper", "master-1.png"), newBytes);
    await writeGallery(deps(ctx));

    const newPath = readDataJs(ctx.galleryDir).characters[0]?.assets[0]?.path;
    assert.equal(newPath, `media/isolde-keeper/${hashedName("master-1", newBytes)}`);
    assert.notEqual(newPath, oldPath);
    assert.deepEqual(readFileSync(join(ctx.galleryDir, newPath)), newBytes);
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
    await writeGallery(deps(ctx));
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
    await writeGallery(deps(ctx));
    const data = readDataJs(ctx.galleryDir);
    assert.deepEqual(
      data.characters[0]?.assets.map((a) => a.kind),
      ["master"],
    );
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0] ?? "", /outfit.*gone\.png/u);
  } finally {
    teardown(ctx);
  }
});

test("a failing media copy warns and skips that asset, not the whole write", async () => {
  const ctx = setup();
  try {
    const character = await seedCharacter(ctx);
    // A directory where a file should be: existsSync passes, reading throws.
    const bogus = join(ctx.dir, "media", "isolde-keeper", "not-a-file.png");
    mkdirSync(bogus, { recursive: true });
    await ctx.db.insertAsset({ characterId: character.id, kind: "expression", localPath: bogus });

    await writeGallery(deps(ctx));
    const data = readDataJs(ctx.galleryDir);
    assert.deepEqual(
      data.characters[0]?.assets.map((a) => a.kind),
      ["master"],
    );
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0] ?? "", /expression.*copy failed/u);
  } finally {
    teardown(ctx);
  }
});

test("version strictly increases across runs and across database reopens", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    const first = await writeGallery(deps(ctx));
    const second = await writeGallery(deps(ctx));
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);

    // A separate CLI invocation = a fresh database handle.
    ctx.db.close();
    ctx.db = openDatabase(join(ctx.dir, "db.sqlite"));
    const third = await writeGallery(deps(ctx));
    assert.equal(third.version, 3);
    assert.equal(readDataJs(ctx.galleryDir).version, 3);
  } finally {
    teardown(ctx);
  }
});

test("interleaved bumps on separate db handles always mint distinct versions", async () => {
  const ctx = setup();
  try {
    // Two handles on the same file simulate two concurrent CLI processes; the
    // single-statement upsert serializes the bumps even though neither handle
    // sees the other's in-memory state.
    const other = openDatabase(join(ctx.dir, "db.sqlite"));
    try {
      const versions: number[] = [];
      for (let round = 0; round < 3; round += 1) {
        // Deliberately interleaved and sequential — the ordering is the test.
        // oxlint-disable-next-line no-await-in-loop
        const mine = await ctx.db.bumpCounter("gallery_version");
        // oxlint-disable-next-line no-await-in-loop
        const theirs = await other.bumpCounter("gallery_version");
        versions.push(mine, theirs);
      }
      assert.deepEqual(versions, [1, 2, 3, 4, 5, 6]);
    } finally {
      other.close();
    }
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
    await writeGallery(deps(ctx));
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

test("media copies are idempotent across runs (one content-addressed file)", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery(deps(ctx));
    await writeGallery(deps(ctx));
    const masterName = hashedName("master-1", MASTER_BYTES);
    const files = readdirSync(join(ctx.galleryDir, "media", "isolde-keeper"));
    assert.deepEqual(files, [masterName]);
    assert.deepEqual(
      readFileSync(join(ctx.galleryDir, "media", "isolde-keeper", masterName)),
      MASTER_BYTES,
    );
  } finally {
    teardown(ctx);
  }
});

test("writeGallery without a built SPA and no prior index.html throws GALLERY_NOT_BUILT", async () => {
  const ctx = setup();
  try {
    await assert.rejects(
      writeGallery(deps(ctx, { spaHtmlPath: join(ctx.dir, "no-such-dist.html") })),
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
    const result = await writeGallery(
      deps(ctx, { spaHtmlPath: join(ctx.dir, "no-such-dist.html") }),
    );
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
    await refreshGalleryIfPresent(deps(ctx));
    assert.equal(existsSync(ctx.galleryDir), false);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent rewrites an existing gallery", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery(deps(ctx));
    await refreshGalleryIfPresent(deps(ctx));
    assert.equal(readDataJs(ctx.galleryDir).version, 2);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent never throws — a missing SPA warns instead", async () => {
  const ctx = setup();
  try {
    // Gallery dir exists but is unusable: no index.html and no built SPA.
    mkdirSync(ctx.galleryDir, { recursive: true });
    await refreshGalleryIfPresent(deps(ctx, { spaHtmlPath: join(ctx.dir, "no-such-dist.html") }));
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0] ?? "", /gallery refresh failed/u);
  } finally {
    teardown(ctx);
  }
});

test("refreshGalleryIfPresent also absorbs unexpected failures (closed db)", async () => {
  const ctx = setup();
  try {
    await seedCharacter(ctx);
    await writeGallery(deps(ctx));
    ctx.db.close();
    await refreshGalleryIfPresent(deps(ctx));
    assert.ok(ctx.warnings.some((w) => /gallery refresh failed/u.test(w)));
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("refresh warnings for non-plain errors keep the stack for diagnosis", async () => {
  const ctx = setup();
  try {
    mkdirSync(ctx.galleryDir, { recursive: true });
    writeFileSync(join(ctx.galleryDir, "index.html"), "seeded");
    // A TypeError from the db layer is a programmer bug, not an operational
    // failure — the swallowed warning must retain the stack trace.
    const brokenDb = {
      listCharacters() {
        throw new TypeError("boom");
      },
    } as unknown as Database;
    await refreshGalleryIfPresent(deps(ctx, { db: brokenDb }));
    assert.equal(ctx.warnings.length, 1);
    assert.match(ctx.warnings[0] ?? "", /TypeError: boom/u);
    assert.match(ctx.warnings[0] ?? "", /\n\s+at /u);
  } finally {
    teardown(ctx);
  }
});
