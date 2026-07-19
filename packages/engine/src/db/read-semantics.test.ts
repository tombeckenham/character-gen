import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./index.ts";
import type { CharacterProfile } from "../types.ts";

function tmpDbFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-db-"));
  return { file: join(dir, "db.sqlite"), dir };
}

const profile: CharacterProfile = { name: "Isolde", identifier: "isolde-keeper" };

test("reading a row with a corrupt profile throws a clear error", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  const created = await db.insertCharacter({ identifier: "ok", name: "Ok", profile });
  db.close();
  // Corrupt the persisted profile out-of-band (blank name/identifier) via a raw
  // connection, so the write itself doesn't pass through rowToCharacter.
  const raw = new DatabaseSync(file);
  raw
    .prepare("UPDATE characters SET profile = ? WHERE id = ?")
    .run(JSON.stringify({ name: "", identifier: "" }), created.id);
  raw.close();

  const db2 = openDatabase(file);
  try {
    await assert.rejects(() => db2.getCharacter("ok"), /corrupt profile row/u);
  } finally {
    db2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading a row with a partial status normalizes to a full status", async () => {
  const { file, dir } = tmpDbFile();
  const db = openDatabase(file);
  try {
    const created = await db.insertCharacter({ identifier: "norm", name: "Norm", profile });
    // Write a status blob missing keys and carrying a bogus value/extra key.
    await db.updateCharacter(created.id, {
      status: { sheet: "done", bogus: "nope", voice: "weird" } as unknown as never,
    });
    const found = await db.getCharacter("norm");
    assert.ok(found);
    assert.deepEqual(found.status, {
      profile: "pending",
      sheet: "done",
      turnaround: "pending",
      // "weird" is not a valid StepState → defaulted back to "pending"
      voice: "pending",
      publish: "pending",
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
