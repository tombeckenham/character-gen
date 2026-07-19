import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@character-gen/engine";
import type { GenmediaResult } from "@character-gen/engine";
import { cmdPublish } from "./publish-cmd.ts";

async function seedPublishable(dir: string): Promise<void> {
  const store = openStore(join(dir, "characters"));
  try {
    const character = await store.insertCharacter({
      identifier: "isolde-keeper",
      name: "Isolde",
      profile: { name: "Isolde", identifier: "isolde-keeper", archetype: "keeper" },
    });
    await store.insertAsset({
      characterId: character.id,
      kind: "master",
      falRequestId: "req-master",
      url: "https://fal.media/master.png",
    });
  } finally {
    store.close();
  }
}

function fakeRunner(result: Partial<GenmediaResult> = {}): {
  run: (args: string[]) => Promise<GenmediaResult>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return Promise.resolve({
        status: result.status ?? 0,
        stdout: result.stdout ?? JSON.stringify({ character: { id: "fal-abc" } }),
        stderr: result.stderr ?? "",
      });
    },
  };
}

test("publish pushes via the injected runner and persists the fal id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-publish-cmd-"));
  try {
    await seedPublishable(dir);
    const runner = fakeRunner();
    const code = await cmdPublish(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      runGenmedia: runner.run,
    });
    assert.equal(code, 0);
    assert.equal(runner.calls.length, 1);

    const store = openStore(join(dir, "characters"));
    try {
      const character = await store.getCharacter("isolde-keeper");
      assert.equal(character?.falCharacterId, "fal-abc");
      assert.equal(character?.status.publish, "done");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish for an unknown character exits 1 without touching genmedia", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-publish-cmd-"));
  try {
    const runner = fakeRunner();
    const code = await cmdPublish(["ghost"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      runGenmedia: runner.run,
    });
    assert.equal(code, 1);
    assert.equal(runner.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing genmedia run exits 1 and marks the step error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-publish-cmd-"));
  try {
    await seedPublishable(dir);
    const runner = fakeRunner({ status: 1, stderr: "401" });
    const code = await cmdPublish(["isolde-keeper"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      runGenmedia: runner.run,
    });
    assert.equal(code, 1);
    const store = openStore(join(dir, "characters"));
    try {
      assert.equal((await store.getCharacter("isolde-keeper"))?.status.publish, "error");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish without a target prints usage and exits 1", async () => {
  const code = await cmdPublish([], { runGenmedia: fakeRunner().run });
  assert.equal(code, 1);
});
