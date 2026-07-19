import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/index.ts";
import type { Database } from "../db/index.ts";
import type { CharacterProfile, CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import {
  buildVoiceDesignPrompt,
  findDesignedVoiceId,
  makeFalVoiceGenerator,
  runSpeak,
  runVoice,
} from "./voice.ts";
import type { SpeechInput, VoiceDesignInput, VoiceGenerator } from "./voice.ts";

/** A scriptable fake VoiceGenerator recording its calls, optionally failing. */
function fakeGenerator(options: { failDesign?: boolean; failSpeak?: boolean } = {}): {
  generator: VoiceGenerator;
  designs: VoiceDesignInput[];
  speaks: SpeechInput[];
} {
  const designs: VoiceDesignInput[] = [];
  const speaks: SpeechInput[] = [];
  const generator: VoiceGenerator = {
    design(input, onProgress) {
      designs.push(input);
      if (options.failDesign) return Promise.reject(new Error("design boom"));
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: "req-voice",
        url: "https://fal.media/voice-preview.mp3",
        customVoiceId: "voice-xyz",
      });
    },
    speak(input, onProgress) {
      speaks.push(input);
      if (options.failSpeak) return Promise.reject(new Error("speak boom"));
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: `req-speech-${speaks.length}`,
        url: `https://fal.media/speech-${speaks.length}.mp3`,
      });
    },
  };
  return { generator, designs, speaks };
}

/** A fetch that returns tiny audio bytes for any URL. */
const fakeFetch: FetchImpl = ((_url: string | URL | Request) =>
  Promise.resolve(new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200 }))) as FetchImpl;

function setup(): { db: Database; dir: string; mediaDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-voice-"));
  return { db: openDatabase(join(dir, "db.sqlite")), dir, mediaDir: join(dir, "media") };
}

function seed(db: Database, profile: Partial<CharacterProfile> = {}): Promise<CharacterRecord> {
  return db.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: {
      name: "Isolde",
      identifier: "isolde-keeper",
      voiceDescription: "low, gravelly alto; unhurried; faint coastal lilt",
      ...profile,
    },
  });
}

/** Seeds a character whose profile carries no voice cues at all. */
function seedVoiceless(db: Database): Promise<CharacterRecord> {
  return db.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: { name: "Isolde", identifier: "isolde-keeper" },
  });
}

test("runVoice designs the voice, stores the sample with the custom voice id, marks done", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seed(db);
    const { generator, designs } = fakeGenerator();

    const outcome = await runVoice(character, { db, generator, mediaDir, fetchImpl: fakeFetch });

    assert.equal(designs.length, 1);
    assert.equal(designs[0]?.prompt, "low, gravelly alto; unhurried; faint coastal lilt");
    assert.ok(designs[0]?.previewText.includes("Isolde"));

    assert.equal(outcome.customVoiceId, "voice-xyz");
    assert.equal(outcome.sample.kind, "voice_sample");
    assert.equal(outcome.sample.meta?.["customVoiceId"], "voice-xyz");
    assert.ok(existsSync(join(mediaDir, "isolde-keeper", "voice-sample.mp3")));

    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "done");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice without a voice description errors, runs nothing, keeps status pending", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seedVoiceless(db);
    const { generator, designs } = fakeGenerator();

    await assert.rejects(
      () => runVoice(character, { db, generator, mediaDir, fetchImpl: fakeFetch }),
      /No voice description.*voiceDescription/u,
    );
    assert.equal(designs.length, 0);
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "pending");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice marks the step error when the design fails", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seed(db);
    const { generator } = fakeGenerator({ failDesign: true });
    await assert.rejects(
      () => runVoice(character, { db, generator, mediaDir, fetchImpl: fakeFetch }),
      /design boom/u,
    );
    const refreshed = await db.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "error");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSpeak voices a line with the designed voice id and stores distinct speech clips", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seed(db);
    const { generator, speaks } = fakeGenerator();
    await runVoice(character, { db, generator, mediaDir, fetchImpl: fakeFetch });

    const first = await runSpeak(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch,
      line: "You should not have come here.",
      emotion: "angry",
    });
    const second = await runSpeak(character, {
      db,
      generator,
      mediaDir,
      fetchImpl: fakeFetch,
      line: "But since you have, sit.",
    });

    assert.equal(speaks[0]?.voiceId, "voice-xyz");
    assert.equal(speaks[0]?.emotion, "angry");
    assert.equal(speaks[1]?.emotion, undefined);
    assert.equal(first.speech.kind, "speech");
    assert.notEqual(first.speech.localPath, second.speech.localPath);
    assert.equal(first.speech.meta?.["text"], "You should not have come here.");

    const speeches = (await db.getAssets(character.id)).filter((a) => a.kind === "speech");
    assert.equal(speeches.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSpeak without a designed voice errors clearly and generates nothing", async () => {
  const { db, dir, mediaDir } = setup();
  try {
    const character = await seed(db);
    const { generator, speaks } = fakeGenerator();
    await assert.rejects(
      () => runSpeak(character, { db, generator, mediaDir, fetchImpl: fakeFetch, line: "Hello?" }),
      /No designed voice.*character-gen voice isolde-keeper/u,
    );
    assert.equal(speaks.length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDesignedVoiceId returns the newest custom voice id, or null when none", async () => {
  const { db, dir } = setup();
  try {
    const character = await seed(db);
    assert.equal(await findDesignedVoiceId(db, character.id), null);
    await db.insertAsset({
      characterId: character.id,
      kind: "voice_sample",
      meta: { customVoiceId: "voice-1" },
    });
    await db.insertAsset({
      characterId: character.id,
      kind: "voice_sample",
      meta: { customVoiceId: "voice-2" },
    });
    assert.equal(await findDesignedVoiceId(db, character.id), "voice-2");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildVoiceDesignPrompt prefers the voice description, composes from traits, else null", () => {
  const base: CharacterProfile = { name: "X", identifier: "x" };
  assert.equal(
    buildVoiceDesignPrompt({ ...base, voiceDescription: "  breathy tenor " }),
    "breathy tenor",
  );
  assert.equal(
    buildVoiceDesignPrompt({ ...base, archetype: "pirate", personality: "brash" }),
    "A distinctive character voice for pirate, brash.",
  );
  assert.equal(buildVoiceDesignPrompt(base), null);
});

test("makeFalVoiceGenerator conforms to the voice-design and speech schemas", async () => {
  const calls: Array<{ endpoint: string; input: unknown }> = [];
  const fakeClient = {
    subscribe(endpoint: string, options: { input: unknown }) {
      calls.push({ endpoint, input: options.input });
      return Promise.resolve(
        endpoint.includes("voice-design")
          ? {
              requestId: "req-d",
              data: { custom_voice_id: "cv-1", audio: { url: "https://fal.media/p.mp3" } },
            }
          : {
              requestId: "req-s",
              data: { audio: { url: "https://fal.media/s.mp3" }, duration_ms: 10 },
            },
      );
    },
  } as unknown as Parameters<typeof makeFalVoiceGenerator>[0];

  const generator = makeFalVoiceGenerator(fakeClient);
  const designed = await generator.design({ prompt: "gruff", previewText: "hi" });
  assert.deepEqual(calls[0], {
    endpoint: "fal-ai/minimax/voice-design",
    input: { prompt: "gruff", preview_text: "hi" },
  });
  assert.equal(designed.customVoiceId, "cv-1");
  assert.equal(designed.url, "https://fal.media/p.mp3");

  const spoken = await generator.speak({ text: "line", voiceId: "cv-1", emotion: "sad" });
  assert.deepEqual(calls[1], {
    endpoint: "fal-ai/minimax/speech-02-hd",
    input: { text: "line", voice_setting: { voice_id: "cv-1", emotion: "sad" } },
  });
  assert.equal(spoken.url, "https://fal.media/s.mp3");
});
