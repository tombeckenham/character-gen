import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readApiKeyFromFile, readJsonFile } from "./config.ts";

function tmpFile(contents: string): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, contents);
  return { file, dir };
}

test("readJsonFile returns null for a missing file", () => {
  assert.equal(readJsonFile(join(tmpdir(), "definitely-missing-xyz.json")), null);
});

for (const [label, payload] of [
  ["an array", "[1, 2, 3]"],
  ["a bare string", '"just a string"'],
  ["a JSON null", "null"],
  ["a number", "42"],
  ["invalid JSON", "{ not valid "],
] as const) {
  test(`readJsonFile returns null for ${label}`, () => {
    const { file, dir } = tmpFile(payload);
    try {
      assert.equal(readJsonFile(file), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("readJsonFile returns the object for a JSON object", () => {
  const { file, dir } = tmpFile(JSON.stringify({ apiKey: "k", extra: 1 }));
  try {
    assert.deepEqual(readJsonFile(file), { apiKey: "k", extra: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readApiKeyFromFile rejects non-string and empty apiKey values", () => {
  for (const value of [123, "", null, false]) {
    const { file, dir } = tmpFile(JSON.stringify({ apiKey: value }));
    try {
      assert.equal(readApiKeyFromFile(file), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const good = tmpFile(JSON.stringify({ apiKey: "real-key" }));
  try {
    assert.equal(readApiKeyFromFile(good.file), "real-key");
  } finally {
    rmSync(good.dir, { recursive: true, force: true });
  }
});
