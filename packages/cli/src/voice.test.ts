import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@character-gen/engine";
import type { CharacterStore, VoiceGenerator } from "@character-gen/engine";
import { cmdSpeak, cmdVoice } from "./pipeline.ts";

const MP3 = "data:audio/mpeg;base64,SUQz";

/** A working voice generator that returns data: URLs (offline download path). */
const okGenerator: VoiceGenerator = {
  design: () => Promise.resolve({ requestId: "req-v", url: MP3, customVoiceId: "cv-1" }),
  speak: () => Promise.resolve({ requestId: "req-s", url: MP3 }),
};

async function seed(dir: string): Promise<void> {
  const store: CharacterStore = openStore(join(dir, "characters"));
  await store.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: { name: "Isolde", identifier: "isolde-keeper", voiceDescription: "gravelly alto" },
  });
  store.close();
}

test("voice then speak records a voice_sample and a speech asset through the CLI seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-voice-cli-"));
  try {
    await seed(dir);
    const env = { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv;

    assert.equal(await cmdVoice(["isolde-keeper"], { env, generator: okGenerator }), 0);
    assert.equal(
      await cmdSpeak(["isolde-keeper", "Hello there.", "--emotion", "happy"], {
        env,
        generator: okGenerator,
      }),
      0,
    );

    const store = openStore(join(dir, "characters"));
    try {
      const character = await store.getCharacter("isolde-keeper");
      assert.equal(character?.status.voice, "done");
      const assets = await store.getAssets(character?.id ?? "");
      assert.equal(assets.filter((a) => a.kind === "voice_sample").length, 1);
      assert.equal(assets.filter((a) => a.kind === "speech").length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("speak before voice exits 1 pointing at the voice command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-voice-cli-"));
  try {
    await seed(dir);
    const code = await cmdSpeak(["isolde-keeper", "Hello?"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: okGenerator,
    });
    assert.equal(code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("speak rejects an unknown --emotion before any synthesis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chargen-voice-cli-"));
  try {
    await seed(dir);
    let spoke = false;
    const spyGenerator: VoiceGenerator = {
      design: okGenerator.design,
      speak: (input, onProgress) => {
        spoke = true;
        return okGenerator.speak(input, onProgress);
      },
    };
    const code = await cmdSpeak(["isolde-keeper", "Hi", "--emotion", "smug"], {
      env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
      generator: spyGenerator,
    });
    assert.equal(code, 1);
    assert.equal(spoke, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
