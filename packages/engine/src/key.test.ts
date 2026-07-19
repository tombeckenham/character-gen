import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFalKey } from "./key.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "chargen-key-"));
}

// An env with no FAL_KEY, so tests never leak the developer's real key.
const noEnv: NodeJS.ProcessEnv = {};

test("FAL_KEY env var wins over both config files", () => {
  const dir = tmp();
  try {
    const genmedia = join(dir, "genmedia.json");
    const state = join(dir, "state.json");
    writeFileSync(genmedia, JSON.stringify({ apiKey: "from-genmedia" }));
    writeFileSync(state, JSON.stringify({ apiKey: "from-state" }));
    const result = resolveFalKey({
      env: { FAL_KEY: "from-env" },
      genmediaConfigPath: genmedia,
      stateConfigPath: state,
    });
    assert.deepEqual(result, { ok: true, key: "from-env", source: "env" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("genmedia config is used when no env key", () => {
  const dir = tmp();
  try {
    const genmedia = join(dir, "genmedia.json");
    const state = join(dir, "state.json");
    writeFileSync(genmedia, JSON.stringify({ apiKey: "from-genmedia" }));
    writeFileSync(state, JSON.stringify({ apiKey: "from-state" }));
    const result = resolveFalKey({
      env: noEnv,
      genmediaConfigPath: genmedia,
      stateConfigPath: state,
    });
    assert.deepEqual(result, { ok: true, key: "from-genmedia", source: "genmedia" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("falls through malformed genmedia config to state config", () => {
  const dir = tmp();
  try {
    const genmedia = join(dir, "genmedia.json");
    const state = join(dir, "state.json");
    writeFileSync(genmedia, "{ this is not valid json ");
    writeFileSync(state, JSON.stringify({ apiKey: "from-state" }));
    const result = resolveFalKey({
      env: noEnv,
      genmediaConfigPath: genmedia,
      stateConfigPath: state,
    });
    assert.deepEqual(result, { ok: true, key: "from-state", source: "config" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty-string apiKey is skipped as if absent", () => {
  const dir = tmp();
  try {
    const genmedia = join(dir, "genmedia.json");
    const state = join(dir, "state.json");
    writeFileSync(genmedia, JSON.stringify({ apiKey: "" }));
    writeFileSync(state, JSON.stringify({ apiKey: "from-state" }));
    const result = resolveFalKey({
      env: noEnv,
      genmediaConfigPath: genmedia,
      stateConfigPath: state,
    });
    assert.equal(result.ok, true);
    assert.equal(result.key, "from-state");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns not-ok when no source provides a key", () => {
  const dir = tmp();
  try {
    const result = resolveFalKey({
      env: noEnv,
      genmediaConfigPath: join(dir, "missing-genmedia.json"),
      stateConfigPath: join(dir, "missing-state.json"),
    });
    assert.deepEqual(result, { ok: false, key: null, source: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
