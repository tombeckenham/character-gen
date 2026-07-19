import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnvFiles } from "./load-env.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "chargen-env-"));
}

/** Removes any keys this test added so cases stay isolated. */
function cleanupKeys(keys: string[]): void {
  for (const k of keys) delete process.env[k];
}

test("loads a key from .env when absent from the real environment", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".env"), "CHARGEN_TEST_A=from_env_file\n");
    loadDotEnvFiles(dir);
    assert.equal(process.env["CHARGEN_TEST_A"], "from_env_file");
  } finally {
    cleanupKeys(["CHARGEN_TEST_A"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test(".env.local wins over .env", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, ".env"), "CHARGEN_TEST_B=from_env\n");
    writeFileSync(join(dir, ".env.local"), "CHARGEN_TEST_B=from_local\n");
    loadDotEnvFiles(dir);
    assert.equal(process.env["CHARGEN_TEST_B"], "from_local");
  } finally {
    cleanupKeys(["CHARGEN_TEST_B"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real environment variable is never overridden by a dotenv file", () => {
  const dir = tmp();
  try {
    process.env["CHARGEN_TEST_C"] = "from_real_env";
    writeFileSync(join(dir, ".env"), "CHARGEN_TEST_C=from_env_file\n");
    loadDotEnvFiles(dir);
    assert.equal(process.env["CHARGEN_TEST_C"], "from_real_env");
  } finally {
    cleanupKeys(["CHARGEN_TEST_C"]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory with no dotenv files is a no-op, not an error", () => {
  const dir = tmp();
  try {
    assert.doesNotThrow(() => loadDotEnvFiles(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
