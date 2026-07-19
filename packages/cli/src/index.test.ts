import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  const res = runCli(["turnaround", "someone"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /coming soon/u);
});
