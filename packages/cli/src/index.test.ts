import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dirname, "index.ts");

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI in a subprocess with a fully isolated environment: no FAL_KEY,
 * and HOME/CHARACTER_GEN_HOME pointed at an empty temp dir so neither the real
 * ~/.genmedia key nor the real state dir leaks in. Offline — no key resolves, so
 * commands that would ping fal are exercised on their degraded path.
 */
function runCli(args: string[]): CliResult {
  const dir = mkdtempSync(join(tmpdir(), "chargen-cli-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, CHARACTER_GEN_HOME: dir };
    delete env["FAL_KEY"];
    delete env["FAL_KEY_ID"];
    delete env["FAL_KEY_SECRET"];
    const proc = spawnSync(process.execPath, [ENTRY, ...args], {
      env,
      encoding: "utf8",
    });
    return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
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

test("an unimplemented pipeline command exits 1 with a phase note", () => {
  const res = runCli(["turnaround", "someone"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not implemented yet \(phase 5\)/u);
});
