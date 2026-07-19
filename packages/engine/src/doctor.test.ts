import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeVersionOk, runDoctor } from "./doctor.ts";
import type { FetchImpl } from "./fal.ts";

function okFetch(): FetchImpl {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ characters: [] }), { status: 200 }),
    )) as unknown as FetchImpl;
}

function statusFetch(status: number): FetchImpl {
  return (() => Promise.resolve(new Response("{}", { status }))) as unknown as FetchImpl;
}

test("nodeVersionOk enforces the >= 22.18 floor", () => {
  assert.equal(nodeVersionOk("22.18.0"), true);
  assert.equal(nodeVersionOk("22.18.1"), true);
  assert.equal(nodeVersionOk("24.13.1"), true);
  assert.equal(nodeVersionOk("23.6.0"), true);
  assert.equal(nodeVersionOk("22.17.0"), false);
  assert.equal(nodeVersionOk("20.0.0"), false);
  assert.equal(nodeVersionOk("garbage"), false);
});

test("runDoctor reports healthy with an env key and a passing ping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-doctor-"));
  try {
    const report = await runDoctor({
      env: { FAL_KEY: "env-key", CHARACTER_GEN_HOME: dir },
      fetchImpl: okFetch(),
    });
    assert.equal(report.keySource, "env");
    assert.ok(report.ping);
    assert.equal(report.ping.ok, true);
    assert.equal(report.storeOk, true);
    assert.equal(report.stateDir, dir);
    // healthy iff Node is also new enough (true on the supported runtime).
    assert.equal(report.healthy, report.nodeOk);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor hints at encryption when a genmedia key is rejected with 401", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-doctor-"));
  try {
    const genmedia = join(dir, "genmedia.json");
    writeFileSync(genmedia, JSON.stringify({ apiKey: "encrypted-blob-that-401s" }));
    const report = await runDoctor({
      env: { CHARACTER_GEN_HOME: dir },
      genmediaConfigPath: genmedia,
      stateConfigPath: join(dir, "no-state.json"),
      fetchImpl: statusFetch(401),
    });
    assert.equal(report.keySource, "genmedia");
    assert.ok(report.ping);
    assert.equal(report.ping.ok, false);
    assert.equal(report.ping.status, 401);
    assert.ok(report.hint);
    assert.match(report.hint, /character-gen setup/u);
    assert.equal(report.healthy, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor with no key skips the ping and is unhealthy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-doctor-"));
  try {
    const report = await runDoctor({
      env: { CHARACTER_GEN_HOME: dir },
      genmediaConfigPath: join(dir, "no-genmedia.json"),
      stateConfigPath: join(dir, "no-state.json"),
      fetchImpl: okFetch(),
    });
    assert.equal(report.keySource, null);
    assert.equal(report.ping, null);
    assert.equal(report.storeOk, true);
    assert.equal(report.healthy, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDoctor reports a store failure when the characters path is unreadable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-doctor-"));
  try {
    // A plain file where the characters/ directory should be forces the
    // store's listCharacters scan to fail.
    writeFileSync(join(dir, "characters"), "not a directory");
    const report = await runDoctor({
      env: { FAL_KEY: "env-key", CHARACTER_GEN_HOME: dir },
      fetchImpl: okFetch(),
    });
    assert.equal(report.storeOk, false);
    assert.ok(report.storeError && report.storeError.length > 0);
    assert.equal(report.healthy, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
