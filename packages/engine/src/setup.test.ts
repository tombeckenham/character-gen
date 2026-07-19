import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeValidatedKey } from "./setup.ts";
import { readApiKeyFromFile } from "./config.ts";
import type { FetchImpl } from "./fal.ts";

function statusFetch(status: number): FetchImpl {
  return (() => Promise.resolve(new Response("{}", { status }))) as unknown as FetchImpl;
}

function throwingFetch(message: string): FetchImpl {
  return (() => Promise.reject(new Error(message))) as unknown as FetchImpl;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "chargen-setup-"));
}

test("valid key: stored and verified, config is 0600", async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, "config.json");
    const result = await storeValidatedKey({
      key: "good-key",
      configFile,
      fetchImpl: statusFetch(200),
    });
    assert.equal(result.stored, true);
    assert.equal(result.verified, true);
    assert.equal(readApiKeyFromFile(configFile), "good-key");
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid key (401): not stored, nothing written", async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, "config.json");
    const result = await storeValidatedKey({
      key: "bad-key",
      configFile,
      fetchImpl: statusFetch(401),
    });
    assert.equal(result.stored, false);
    assert.equal(result.verified, false);
    assert.ok(!result.stored && result.ping.status === 401);
    assert.equal(existsSync(configFile), false, "no config file should be written on rejection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unverifiable key (network error): stored anyway with verified:false", async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, "config.json");
    const result = await storeValidatedKey({
      key: "maybe-good",
      configFile,
      fetchImpl: throwingFetch("ECONNREFUSED"),
    });
    assert.equal(result.stored, true);
    assert.equal(result.verified, false);
    assert.equal(readApiKeyFromFile(configFile), "maybe-good");
    assert.ok(result.stored && !result.verified && result.ping.ok === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overwriting a 0644 config tightens the mode to 0600", async () => {
  const dir = tmp();
  try {
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, JSON.stringify({ apiKey: "old" }), { mode: 0o644 });
    assert.equal(statSync(configFile).mode & 0o777, 0o644, "precondition: file is 0644");
    const result = await storeValidatedKey({
      key: "new-key",
      configFile,
      fetchImpl: statusFetch(200),
    });
    assert.equal(result.stored, true);
    assert.equal(statSync(configFile).mode & 0o777, 0o600);
    assert.equal(readApiKeyFromFile(configFile), "new-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
