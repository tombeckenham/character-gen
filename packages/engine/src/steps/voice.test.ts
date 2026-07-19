import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/index.ts";
import type { CharacterStore } from "../store/index.ts";
import type { CharacterProfile, CharacterRecord } from "../types.ts";
import type { FetchImpl } from "../fal.ts";
import {
  buildVoiceDesignPrompt,
  findDesignedVoiceId,
  makeFalVoiceGenerator,
  runSpeak,
  runVoice,
} from "./voice.ts";
import type { VoiceGenerator } from "./voice.ts";
import { resolveVoiceModel } from "./voice-models.ts";
import type { SpeechInput, VoiceDesignInput, VoiceModel } from "./voice-models.ts";

/** The default (minimax) model, used to drive the executor directly. */
const MINIMAX = resolveVoiceModel({ name: "x", identifier: "x" });

/** A scriptable fake VoiceGenerator recording its calls, optionally failing. */
function fakeGenerator(options: { failDesign?: boolean; failSpeak?: boolean } = {}): {
  generator: VoiceGenerator;
  designs: Array<{ model: string; input: VoiceDesignInput }>;
  speaks: Array<{ model: string; input: SpeechInput }>;
} {
  const designs: Array<{ model: string; input: VoiceDesignInput }> = [];
  const speaks: Array<{ model: string; input: SpeechInput }> = [];
  const generator: VoiceGenerator = {
    design(model, input, onProgress) {
      designs.push({ model: model.key, input });
      if (options.failDesign) return Promise.reject(new Error("design boom"));
      onProgress?.({ status: "COMPLETED" });
      return Promise.resolve({
        requestId: "req-voice",
        url: "https://fal.media/voice-preview.mp3",
        customVoiceId: "voice-xyz",
      });
    },
    speak(model, input, onProgress) {
      speaks.push({ model: model.key, input });
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

function setup(): { store: CharacterStore; dir: string; charactersDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chargen-voice-"));
  return {
    store: openStore(join(dir, "characters"), { onWarn: () => {} }),
    dir,
    charactersDir: join(dir, "characters"),
  };
}

function seed(
  store: CharacterStore,
  profile: Partial<CharacterProfile> = {},
): Promise<CharacterRecord> {
  return store.insertCharacter({
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
function seedVoiceless(store: CharacterStore): Promise<CharacterRecord> {
  return store.insertCharacter({
    identifier: "isolde-keeper",
    name: "Isolde",
    profile: { name: "Isolde", identifier: "isolde-keeper" },
  });
}

test("runVoice designs the voice, stores the sample with the custom voice id, marks done", async () => {
  const { store, dir, charactersDir } = setup();
  try {
    const character = await seed(store);
    const { generator, designs, speaks } = fakeGenerator();

    const outcome = await runVoice(character, { store, generator, fetchImpl: fakeFetch });

    assert.equal(designs.length, 1);
    assert.equal(speaks.length, 0);
    assert.equal(designs[0]?.model, "minimax");
    assert.equal(designs[0]?.input.prompt, "low, gravelly alto; unhurried; faint coastal lilt");
    assert.ok(designs[0]?.input.previewText.includes("Isolde"));

    assert.equal(outcome.designed, true);
    assert.equal(outcome.model, "minimax");
    assert.equal(outcome.voiceRef, "voice-xyz");
    assert.equal(outcome.sample.kind, "voice_sample");
    assert.equal(outcome.sample.meta?.["customVoiceId"], "voice-xyz");
    assert.ok(existsSync(join(charactersDir, "isolde-keeper", "voice-sample.mp3")));

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice with a preset previews it (no design), stores preset in meta, marks done", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store, { voice: { model: "elevenlabs", preset: "Adam" } });
    const { generator, designs, speaks } = fakeGenerator();

    const outcome = await runVoice(character, { store, generator, fetchImpl: fakeFetch });

    assert.equal(designs.length, 0);
    assert.equal(speaks.length, 1);
    assert.equal(speaks[0]?.model, "elevenlabs");
    assert.equal(speaks[0]?.input.voiceRef, "Adam");
    assert.equal(outcome.designed, false);
    assert.equal(outcome.model, "elevenlabs");
    assert.equal(outcome.voiceRef, "Adam");
    assert.equal(outcome.sample.meta?.["preset"], "Adam");
    assert.equal(outcome.sample.meta?.["customVoiceId"], undefined);

    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "done");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice on a preset-only model with no preset uses the model default", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store, { voice: { model: "seed-speech" } });
    const { generator, designs, speaks } = fakeGenerator();

    const outcome = await runVoice(character, { store, generator, fetchImpl: fakeFetch });

    assert.equal(designs.length, 0);
    assert.equal(speaks[0]?.input.voiceRef, "stokie_en");
    assert.equal(outcome.designed, false);
    assert.equal(outcome.voiceRef, "stokie_en");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice rejects an unknown preset on a closed-enum model before running", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store, { voice: { model: "seed-speech", preset: "Rachel" } });
    const { generator, speaks } = fakeGenerator();

    await assert.rejects(
      () => runVoice(character, { store, generator, fetchImpl: fakeFetch }),
      /Unknown preset "Rachel".*seed-speech/u,
    );
    assert.equal(speaks.length, 0);
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice rejects an unknown model before running", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store, { voice: { model: "nope" } });
    const { generator } = fakeGenerator();
    await assert.rejects(
      () => runVoice(character, { store, generator, fetchImpl: fakeFetch }),
      /Unknown voice model "nope"/u,
    );
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice without a voice description errors, runs nothing, keeps status pending", async () => {
  const { store, dir } = setup();
  try {
    const character = await seedVoiceless(store);
    const { generator, designs } = fakeGenerator();

    await assert.rejects(
      () => runVoice(character, { store, generator, fetchImpl: fakeFetch }),
      /No voice description.*voiceDescription/u,
    );
    assert.equal(designs.length, 0);
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runVoice marks the step error when the design fails", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    const { generator } = fakeGenerator({ failDesign: true });
    await assert.rejects(
      () => runVoice(character, { store, generator, fetchImpl: fakeFetch }),
      /design boom/u,
    );
    const refreshed = await store.getCharacter(character.id);
    assert.equal(refreshed?.status.voice, "error");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSpeak voices a line with the designed voice id and stores distinct speech clips", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    const { generator, speaks } = fakeGenerator();
    await runVoice(character, { store, generator, fetchImpl: fakeFetch });

    const first = await runSpeak(character, {
      store,
      generator,
      fetchImpl: fakeFetch,
      line: "You should not have come here.",
      emotion: "angry",
    });
    const second = await runSpeak(character, {
      store,
      generator,
      fetchImpl: fakeFetch,
      line: "But since you have, sit.",
    });

    assert.equal(speaks[0]?.input.voiceRef, "voice-xyz");
    assert.equal(speaks[0]?.input.emotion, "angry");
    assert.equal(speaks[1]?.input.emotion, undefined);
    assert.equal(first.speech.kind, "speech");
    assert.notEqual(first.speech.localPath, second.speech.localPath);
    assert.equal(first.speech.meta?.["text"], "You should not have come here.");

    const speeches = (await store.getAssets(character.id)).filter((a) => a.kind === "speech");
    assert.equal(speeches.length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSpeak uses the profile preset without any designed voice", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store, { voice: { model: "seed-speech", preset: "tim_en" } });
    const { generator, speaks } = fakeGenerator();

    const outcome = await runSpeak(character, {
      store,
      generator,
      fetchImpl: fakeFetch,
      line: "Evening.",
    });

    assert.equal(speaks[0]?.model, "seed-speech");
    assert.equal(speaks[0]?.input.voiceRef, "tim_en");
    assert.equal(outcome.speech.meta?.["voiceRef"], "tim_en");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSpeak without a designed voice errors clearly and generates nothing", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    const { generator, speaks } = fakeGenerator();
    await assert.rejects(
      () => runSpeak(character, { store, generator, fetchImpl: fakeFetch, line: "Hello?" }),
      /No designed voice.*character-gen voice isolde-keeper/u,
    );
    assert.equal(speaks.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDesignedVoiceId returns the newest custom voice id, or null when none", async () => {
  const { store, dir } = setup();
  try {
    const character = await seed(store);
    assert.equal(await findDesignedVoiceId(store, character.id), null);
    await store.insertAsset({
      characterId: character.id,
      kind: "voice_sample",
      meta: { customVoiceId: "voice-1" },
    });
    await store.insertAsset({
      characterId: character.id,
      kind: "voice_sample",
      meta: { customVoiceId: "voice-2" },
    });
    assert.equal(await findDesignedVoiceId(store, character.id), "voice-2");
  } finally {
    store.close();
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
  const designed = await generator.design(MINIMAX, { prompt: "gruff", previewText: "hi" });
  assert.deepEqual(calls[0], {
    endpoint: "fal-ai/minimax/voice-design",
    input: { prompt: "gruff", preview_text: "hi" },
  });
  assert.equal(designed.customVoiceId, "cv-1");
  assert.equal(designed.url, "https://fal.media/p.mp3");

  const spoken = await generator.speak(MINIMAX, { text: "line", voiceRef: "cv-1", emotion: "sad" });
  assert.deepEqual(calls[1], {
    endpoint: "fal-ai/minimax/speech-02-hd",
    input: { text: "line", voice_setting: { voice_id: "cv-1", emotion: "sad" } },
  });
  assert.equal(spoken.url, "https://fal.media/s.mp3");
});

test("a preset-only model's speak input carries the preset and maps emotion", async () => {
  const calls: Array<{ endpoint: string; input: unknown }> = [];
  const fakeClient = {
    subscribe(endpoint: string, options: { input: unknown }) {
      calls.push({ endpoint, input: options.input });
      return Promise.resolve({
        requestId: "r",
        data: { audio: { url: "https://fal.media/s.mp3" } },
      });
    },
  } as unknown as Parameters<typeof makeFalVoiceGenerator>[0];
  const generator = makeFalVoiceGenerator(fakeClient);
  const seedModel: VoiceModel = resolveVoiceModel({
    name: "x",
    identifier: "x",
    voice: { model: "seed-speech" },
  });

  await generator.speak(seedModel, { text: "line", voiceRef: "tim_en", emotion: "happy" });
  assert.deepEqual(calls[0], {
    endpoint: "fal-ai/bytedance/seed-speech/tts/v2",
    input: { text: "line", voice: "tim_en", voice_instruction: "Speak in a happy tone." },
  });

  // A design-capable-only method on a preset-only model is a clear error.
  await assert.rejects(
    () => generator.design(seedModel, { prompt: "x", previewText: "y" }),
    /does not design bespoke voices/u,
  );
});
