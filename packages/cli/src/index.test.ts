// oxlint-disable max-lines -- exhaustive offline test file; length is inherent
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@character-gen/engine";

const ENTRY = join(import.meta.dirname, "index.ts");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, CHARACTER_GEN_HOME: dir };
  // @fal-ai/client and key resolution also honor FAL_KEY_ID / FAL_KEY_SECRET, so
  // clear all three to guarantee no real credential leaks into the subprocess.
  delete env["FAL_KEY"];
  delete env["FAL_KEY_ID"];
  delete env["FAL_KEY_SECRET"];
  return env;
}

/** Runs the CLI in a subprocess against an existing (possibly seeded) home. */
function runCliIn(dir: string, args: string[]): CliResult {
  const proc = spawnSync(process.execPath, [ENTRY, ...args], {
    env: isolatedEnv(dir),
    encoding: "utf8",
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

/**
 * Runs the CLI in a subprocess with a fully isolated, empty environment: no
 * FAL_KEY, and HOME/CHARACTER_GEN_HOME pointed at a fresh temp dir so neither the
 * real ~/.genmedia key nor the real state dir leaks in. Offline — no key
 * resolves, so ping paths run degraded.
 */
function runCli(args: string[]): CliResult {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    return runCliIn(dir, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unknown command prints help to stderr and exits 1", () => {
  const res = runCli(["frobnicate"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown command: frobnicate/u);
  assert.match(res.stderr, /Usage:/u);
});

test("--help exits 0 and prints usage", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/u);
  assert.match(res.stdout, /character-gen <command>/u);
});

test("doctor with no key exits 1, skips the ping, reports state", () => {
  const res = runCli(["doctor"]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /key:\s+none found/u);
  assert.match(res.stdout, /fal ping:\s+skipped \(no key\)/u);
  assert.match(res.stdout, /db:\s+ok/u);
  assert.doesNotMatch(res.stderr, /experimental/iu);
});

test("list on an empty state dir exits 0", () => {
  const res = runCli(["list"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No characters yet/u);
});

test("list renders a table for seeded characters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    db.close();
    const res = runCliIn(dir, ["list"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /IDENTIFIER/u);
    assert.match(res.stdout, /isolde-keeper/u);
    assert.match(res.stdout, /Isolde/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("show without an argument exits 1 with usage", () => {
  const res = runCli(["show"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: character-gen show/u);
});

test("show with an unknown target exits 1", () => {
  const res = runCli(["show", "ghost"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No character found/u);
});

test("show prints a seeded character's profile and assets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    const character = await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    await db.insertAsset({ characterId: character.id, kind: "master", falRequestId: "req-1" });
    db.close();
    const res = runCliIn(dir, ["show", "isolde-keeper"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"identifier": "isolde-keeper"/u);
    assert.match(res.stdout, /"assets"/u);
    assert.match(res.stdout, /"kind": "master"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unimplemented pipeline command exits 1 with a coming-soon note", () => {
  const res = runCli(["voice", "someone"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /coming soon/u);
});

test("create with --steps profile derives a minimal profile and persists it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const res = runCliIn(dir, ["create", "A Lighthouse Keeper", "--steps", "profile"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Created A Lighthouse Keeper \(a-lighthouse-keeper\)/u);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("a-lighthouse-keeper");
      assert.ok(character);
      assert.equal(character.status.profile, "done");
      assert.equal(character.status.sheet, "pending");
      assert.equal(character.profile["description"], "A Lighthouse Keeper");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create derivation suffixes the identifier when the slug is taken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "a-lighthouse-keeper",
      name: "Existing",
      profile: { name: "Existing", identifier: "a-lighthouse-keeper" },
    });
    db.close();
    const res = runCliIn(dir, ["create", "A Lighthouse Keeper", "--steps", "profile"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /a-lighthouse-keeper-2/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create with no description and no --profile-json exits 1 with usage", () => {
  const res = runCli(["create", "--steps", "profile"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: character-gen create/u);
});

test("create --profile-json with a missing file exits 1", () => {
  const res = runCli(["create", "--profile-json", "/no/such/file.json", "--steps", "profile"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Could not read profile file/u);
});

test("create --profile-json with invalid JSON exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    const res = runCliIn(dir, ["create", "--profile-json", file, "--steps", "profile"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not valid JSON/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create --profile-json with an invalid profile shape exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const file = join(dir, "profile.json");
    writeFileSync(file, JSON.stringify({ name: "X", identifier: "Bad Slug" }));
    const res = runCliIn(dir, ["create", "--profile-json", file, "--steps", "profile"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Invalid profile/u);
    assert.match(res.stderr, /must be a slug/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create --steps with a recognized-but-unimplemented step exits 1", () => {
  const res = runCli(["create", "someone", "--steps", "voice"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /recognized but not implemented/u);
});

test("create --steps accepts turnaround (fails at the key, not the step list)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const res = runCliIn(dir, ["create", "someone", "--steps", "profile,sheet,turnaround"]);
    assert.equal(res.status, 1);
    assert.doesNotMatch(res.stderr, /Unknown step|not implemented/u);
    assert.match(res.stdout, /Created someone/u);
    assert.match(res.stderr, /No fal API key found/u);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      assert.ok(await db.getCharacter("someone"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create --steps with an unknown step exits 1", () => {
  const res = runCli(["create", "someone", "--steps", "frobnicate"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown step "frobnicate"/u);
});

test("create --surprise points to the cast skill", () => {
  const res = runCli(["create", "someone", "--surprise"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cast skill/u);
});

test("create (default steps) with a valid profile but no key creates then fails at sheet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const file = join(dir, "profile.json");
    writeFileSync(file, JSON.stringify({ name: "Isolde", identifier: "isolde-keeper" }));
    const res = runCliIn(dir, ["create", "--profile-json", file]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Created Isolde \(isolde-keeper\)/u);
    assert.match(res.stderr, /No fal API key found/u);
    // The character persisted even though the sheet step could not run.
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("isolde-keeper");
      assert.ok(character);
      assert.equal(character.status.sheet, "pending");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create --steps sheet still creates the character (profile step is implicit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    // No key, so the sheet run fails — but the character must already be created.
    const res = runCliIn(dir, ["create", "A Night Watchman", "--steps", "sheet"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Created A Night Watchman \(a-night-watchman\)/u);
    assert.match(res.stderr, /No fal API key found/u);
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const character = await db.getCharacter("a-night-watchman");
      assert.ok(character);
      assert.equal(character.status.profile, "done");
      assert.equal(character.status.sheet, "pending");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sheet on an unknown character exits 1", () => {
  const res = runCli(["sheet", "ghost"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No character found/u);
});

test("sheet on an existing character with no key exits 1 with a setup hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    db.close();
    const res = runCliIn(dir, ["sheet", "isolde-keeper"]);
    assert.equal(res.status, 1);
    // Character lookup succeeds first, so the failure is specifically the key.
    assert.match(res.stderr, /No fal API key found/u);
    assert.match(res.stderr, /setup|doctor/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sheet without an argument exits 1 with usage", () => {
  const res = runCli(["sheet"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: character-gen sheet/u);
});

test("turnaround without an argument exits 1 with usage", () => {
  const res = runCli(["turnaround"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: character-gen turnaround/u);
});

test("turnaround on an unknown character exits 1", () => {
  const res = runCli(["turnaround", "ghost"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No character found/u);
});

test("turnaround on an existing character with no key exits 1 with a setup hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const db = openDatabase(join(dir, "db.sqlite"));
    await db.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper" },
    });
    db.close();
    const res = runCliIn(dir, ["turnaround", "isolde-keeper"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No fal API key found/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root help lists turnaround as available (not coming soon)", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /turnaround <char>\s+Generate the 12-angle spin frames\n/u);
});

/** Seeds a minimal already-opened gallery so refresh/open work without dist. */
function seedGallery(dir: string): string {
  const galleryDir = join(dir, "gallery");
  mkdirSync(galleryDir, { recursive: true });
  writeFileSync(join(galleryDir, "index.html"), "<!doctype html><title>seeded</title>");
  return galleryDir;
}

test("open --no-browser writes the gallery and prints the file:// URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    seedGallery(dir);
    const res = runCliIn(dir, ["open", "--no-browser"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Gallery written:/u);
    assert.match(res.stdout, /file:\/\/.*\/gallery\/index\.html/u);
    const dataJs = readFileSync(join(dir, "gallery", "data.js"), "utf8");
    assert.match(dataJs, /^window\.CHARGEN_DATA = \{"version":1,"characters":\[\]\};/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create refreshes an already-opened gallery", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    seedGallery(dir);
    const res = runCliIn(dir, ["create", "A Lighthouse Keeper", "--steps", "profile"]);
    assert.equal(res.status, 0, res.stderr);
    const dataJs = readFileSync(join(dir, "gallery", "data.js"), "utf8");
    assert.match(dataJs, /a-lighthouse-keeper/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create does not conjure a gallery the user never opened", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const res = runCliIn(dir, ["create", "A Lighthouse Keeper", "--steps", "profile"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(existsSync(join(dir, "gallery")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing gallery refresh warns but never fails the pipeline", () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    // A file where the gallery dir should be makes every write inside it fail.
    writeFileSync(join(dir, "gallery"), "not a directory");
    const res = runCliIn(dir, ["create", "A Lighthouse Keeper", "--steps", "profile"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Created A Lighthouse Keeper/u);
    assert.match(res.stderr, /gallery refresh failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
