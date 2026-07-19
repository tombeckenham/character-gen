// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db/index.ts";
import {
  createCharacter,
  deriveMinimalProfile,
  isUniqueConstraintError,
  isValidIdentifier,
  slugify,
  validateProfile,
} from "./character.ts";

function tmpDb(): { db: ReturnType<typeof openDatabase>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-char-"));
  return { db: openDatabase(join(dir, "db.sqlite")), dir };
}

test("validateProfile accepts a minimal valid profile and returns it typed", () => {
  const profile = validateProfile({ name: "Isolde", identifier: "isolde-keeper" });
  assert.equal(profile.name, "Isolde");
  assert.equal(profile.identifier, "isolde-keeper");
});

test("validateProfile keeps optional canon fields and extra keys", () => {
  const raw = {
    name: "Isolde",
    identifier: "isolde-keeper",
    archetype: "weathered sentinel",
    visualCanon: "silver braid, oilskin coat",
    voiceDescription: "low, salt-worn",
    era: "1890s",
  };
  const profile = validateProfile(raw);
  assert.equal(profile.archetype, "weathered sentinel");
  assert.equal(profile["era"], "1890s");
});

test("validateProfile rejects a non-object", () => {
  assert.throws(() => validateProfile("nope"), /expected a JSON object/u);
  assert.throws(() => validateProfile(null), /expected a JSON object/u);
  assert.throws(() => validateProfile([1, 2]), /expected a JSON object/u);
});

test("validateProfile flags a missing name and identifier together", () => {
  assert.throws(
    () => validateProfile({}),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"name" is required/u);
      assert.match(err.message, /"identifier" is required/u);
      return true;
    },
  );
});

test("validateProfile rejects a non-slug identifier with a helpful message", () => {
  assert.throws(
    () => validateProfile({ name: "X", identifier: "Isolde Keeper" }),
    /must be a slug/u,
  );
  assert.throws(() => validateProfile({ name: "X", identifier: "UPPER" }), /must be a slug/u);
  assert.throws(() => validateProfile({ name: "X", identifier: "under_score" }), /must be a slug/u);
});

test("validateProfile enforces the 64-char identifier cap", () => {
  const long = "a".repeat(65);
  assert.throws(() => validateProfile({ name: "X", identifier: long }), /at most 64 characters/u);
  // Exactly 64 is fine.
  const ok = validateProfile({ name: "X", identifier: "a".repeat(64) });
  assert.equal(ok.identifier.length, 64);
});

test("validateProfile rejects an empty-string name", () => {
  assert.throws(() => validateProfile({ name: "   ", identifier: "ok" }), /"name" is required/u);
});

test("validateProfile rejects a non-string optional field", () => {
  assert.throws(
    () => validateProfile({ name: "X", identifier: "x", archetype: 42 }),
    /"archetype" must be a string/u,
  );
});

test("validateProfile accepts the full rich-sheet field set", () => {
  const profile = validateProfile({
    name: "Aldous Grey",
    identifier: "aldous-grey",
    physical: { apparentAge: "late 40s", heightCm: 178, eyes: "pale grey" },
    imperfections: [
      { what: "thin white scar", where: "left eyebrow to temple", story: "gaff hook" },
      { what: "chipped front tooth", where: "upper left" },
    ],
    signatureItems: ["brass pocket compass"],
    palette: ["storm grey", "oxblood"],
    materials: ["worn oilskin"],
    motion: { gait: "rolling", habit: "thumbs the compass lid" },
    expressions: ["weathered joy", "cold fury"],
    negativeCanon: ["never clean-shaven"],
  });
  assert.equal(profile.physical?.heightCm, 178);
  assert.equal(profile.imperfections?.length, 2);
});

test("validateProfile rejects malformed rich-sheet fields with itemized problems", () => {
  assert.throws(
    () =>
      validateProfile({
        name: "X",
        identifier: "x",
        physical: { heightCm: "tall" },
        motion: { gait: 3 },
        signatureItems: "compass",
        expressions: ["joy", 4],
        imperfections: [{ where: "brow" }, "scar", { what: "scar", where: "brow", story: 9 }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"physical\.heightCm" must be a number/u);
      assert.match(err.message, /"motion\.gait" must be a string/u);
      assert.match(err.message, /"signatureItems" must be an array of strings/u);
      assert.match(err.message, /"expressions" must be an array of strings/u);
      assert.match(err.message, /"imperfections\[0\]\.what" is required/u);
      assert.match(err.message, /"imperfections\[1\]" must be an object/u);
      assert.match(err.message, /"imperfections\[2\]\.story" must be a string/u);
      return true;
    },
  );
});

test("validateProfile rejects non-object physical/motion and non-array imperfections", () => {
  assert.throws(
    () => validateProfile({ name: "X", identifier: "x", physical: ["wiry"] }),
    /"physical" must be an object/u,
  );
  assert.throws(
    () => validateProfile({ name: "X", identifier: "x", imperfections: { what: "scar" } }),
    /"imperfections" must be an array/u,
  );
});

test("slugify lowercases, strips diacritics, and hyphenates", () => {
  assert.equal(slugify("Isolde the Lighthouse Keeper"), "isolde-the-lighthouse-keeper");
  assert.equal(slugify("Café Owner!!!"), "cafe-owner");
  assert.equal(slugify("  spaced  out  "), "spaced-out");
});

test("slugify caps at 64 chars with no trailing hyphen", () => {
  const slug = slugify("word ".repeat(30));
  assert.ok(slug.length <= 64);
  assert.doesNotMatch(slug, /-$/u);
});

test("slugify returns empty string for input with no slug-able characters", () => {
  assert.equal(slugify("!!! ???"), "");
});

test("createCharacter persists the profile and marks the profile step done", async () => {
  const { db, dir } = tmpDb();
  try {
    const character = await createCharacter(db, { name: "Isolde", identifier: "isolde-keeper" });
    assert.equal(character.identifier, "isolde-keeper");
    assert.equal(character.status.profile, "done");
    assert.equal(character.status.sheet, "pending");
    const fetched = await db.getCharacter("isolde-keeper");
    assert.ok(fetched);
    assert.equal(fetched.name, "Isolde");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createCharacter maps a duplicate identifier to a friendly error", async () => {
  const { db, dir } = tmpDb();
  try {
    await createCharacter(db, { name: "Isolde", identifier: "isolde-keeper" });
    await assert.rejects(
      () => createCharacter(db, { name: "Clone", identifier: "isolde-keeper" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /already exists/u);
        // The raw SQLITE text is not surfaced to the user, but is preserved as cause.
        assert.doesNotMatch(err.message, /UNIQUE constraint/u);
        assert.ok(isUniqueConstraintError(err.cause));
        return true;
      },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isUniqueConstraintError is false for unrelated errors", () => {
  assert.equal(isUniqueConstraintError(new Error("boom")), false);
  assert.equal(isUniqueConstraintError("not an error"), false);
  assert.equal(isUniqueConstraintError(null), false);
});

test("validateProfile rejects path-traversal identifiers", () => {
  assert.throws(() => validateProfile({ name: "X", identifier: "../evil" }), /must be a slug/u);
  assert.throws(() => validateProfile({ name: "X", identifier: "a/b" }), /must be a slug/u);
  assert.throws(() => validateProfile({ name: "X", identifier: ".." }), /must be a slug/u);
});

test("slugify neutralizes traversal-shaped input", () => {
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("..\\..\\windows"), "windows");
});

test("isValidIdentifier accepts slugs and rejects traversal/oversize", () => {
  assert.equal(isValidIdentifier("isolde-keeper"), true);
  assert.equal(isValidIdentifier("a".repeat(64)), true);
  assert.equal(isValidIdentifier(""), false);
  assert.equal(isValidIdentifier("a".repeat(65)), false);
  assert.equal(isValidIdentifier("../evil"), false);
  assert.equal(isValidIdentifier("a/b"), false);
  assert.equal(isValidIdentifier("UPPER"), false);
});

test("deriveMinimalProfile builds a valid profile and stores the description", async () => {
  const { db, dir } = tmpDb();
  try {
    const profile = await deriveMinimalProfile(db, "A Lighthouse Keeper");
    assert.equal(profile.name, "A Lighthouse Keeper");
    assert.equal(profile.identifier, "a-lighthouse-keeper");
    assert.equal(profile["description"], "A Lighthouse Keeper");
    // It funnels through validateProfile, so the identifier is a valid slug.
    assert.ok(isValidIdentifier(profile.identifier));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMinimalProfile truncates a long name with an ellipsis", async () => {
  const { db, dir } = tmpDb();
  try {
    const long = "Detective ".repeat(20).trim();
    const profile = await deriveMinimalProfile(db, long);
    assert.ok(profile.name.length <= 60);
    assert.match(profile.name, /…$/u);
    assert.ok(isValidIdentifier(profile.identifier));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMinimalProfile suffixes on collision and walks -2 → -3", async () => {
  const { db, dir } = tmpDb();
  try {
    await db.insertCharacter({
      identifier: "a-lighthouse-keeper",
      name: "One",
      profile: { name: "One", identifier: "a-lighthouse-keeper" },
    });
    const second = await deriveMinimalProfile(db, "A Lighthouse Keeper");
    assert.equal(second.identifier, "a-lighthouse-keeper-2");
    await db.insertCharacter({
      identifier: second.identifier,
      name: "Two",
      profile: { name: "Two", identifier: second.identifier },
    });
    const third = await deriveMinimalProfile(db, "A Lighthouse Keeper");
    assert.equal(third.identifier, "a-lighthouse-keeper-3");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMinimalProfile terminates for a taken 64-char slug (no hang)", async () => {
  const { db, dir } = tmpDb();
  try {
    // A description whose slug is exactly 64 chars, already taken.
    const base = "a".repeat(64);
    const description = "a".repeat(64);
    await db.insertCharacter({
      identifier: base,
      name: "Existing",
      profile: { name: "Existing", identifier: base },
    });
    const derived = await deriveMinimalProfile(db, description);
    assert.notEqual(derived.identifier, base);
    assert.ok(isValidIdentifier(derived.identifier), derived.identifier);
    assert.ok(derived.identifier.length <= 64);
    // Stem truncated to make room for the suffix; ends in the numeric marker.
    assert.match(derived.identifier, /-2$/u);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMinimalProfile keeps an exactly-64 free slug unchanged", async () => {
  const { db, dir } = tmpDb();
  try {
    const description = "a".repeat(64);
    const derived = await deriveMinimalProfile(db, description);
    assert.equal(derived.identifier, "a".repeat(64));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deriveMinimalProfile falls back to 'character' for slug-less input", async () => {
  const { db, dir } = tmpDb();
  try {
    const derived = await deriveMinimalProfile(db, "日本語 🎭");
    assert.equal(derived.identifier, "character");
    assert.equal(derived.name, "日本語 🎭");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
