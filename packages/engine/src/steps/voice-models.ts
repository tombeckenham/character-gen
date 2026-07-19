// The pluggable voice-model registry. Each character's profile picks a `model`
// (and optionally a stock `preset` voice); this module knows, per model, which
// fal endpoints to call and how to shape their (differing) inputs. The voice
// step (voice.ts) is a thin executor over these descriptors — add a model here,
// not there. Every endpoint/field below is verified against `genmedia schema`.
import type { CharacterProfile } from "../types.ts";

/** Emotions the minimax speech endpoint's `voice_setting.emotion` accepts;
 * other models map or ignore them (see each model's `buildSpeechInput`). */
export const SPEECH_EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "neutral",
] as const;

export type SpeechEmotion = (typeof SPEECH_EMOTIONS)[number];

export interface VoiceDesignInput {
  /** Voice-description prompt that shapes the personalized voice. */
  prompt: string;
  /** Short sample line the design endpoint speaks back (≤500 chars). */
  previewText: string;
}

export interface SpeechInput {
  text: string;
  /** The voice to synthesize with: a designed `custom_voice_id`, or a preset name. */
  voiceRef: string;
  emotion?: SpeechEmotion;
}

/**
 * One TTS model the generator can drive. `speechEndpoint` voices a line;
 * `designEndpoint` (only some models) mints a bespoke voice from a description.
 * The `build*` adapters translate the engine's model-agnostic inputs into each
 * endpoint's specific schema, so the executor stays model-blind.
 */
export interface VoiceModel {
  /** Registry key used in a profile's `voice.model`. */
  key: string;
  label: string;
  description: string;
  speechEndpoint: string;
  /** Present only when the model can design a bespoke voice from a description. */
  designEndpoint?: string;
  /** Known stock voices. Advisory unless `presetsClosed` (then it's the full set). */
  presets: readonly string[];
  /** When true, a preset outside `presets` is rejected (the endpoint enforces an
   * enum); when false the list is a curated sample and any voice name is allowed. */
  presetsClosed: boolean;
  /** The preset used when a preset-only model is chosen with no preset named. */
  defaultPreset: string;
  buildSpeechInput: (input: SpeechInput) => Record<string, unknown>;
  buildDesignInput?: (input: VoiceDesignInput) => Record<string, unknown>;
  /** Pulls the reusable voice id out of a design response (design models only). */
  extractVoiceId?: (data: unknown) => string;
}

/** Pulls the `custom_voice_id` out of a minimax voice-design response, or throws. */
function extractMinimaxVoiceId(data: unknown): string {
  const id = (data as { custom_voice_id?: unknown }).custom_voice_id;
  if (typeof id === "string" && id.length > 0) return id;
  throw new Error("fal voice-design response contained no custom_voice_id");
}

/** minimax: the only model here that designs a bespoke voice; its speech endpoint
 * takes either a designed `custom_voice_id` or one of its predefined voice ids. */
const MINIMAX: VoiceModel = {
  key: "minimax",
  label: "MiniMax",
  description: "Designs a bespoke voice from a description, or speaks with a predefined voice.",
  speechEndpoint: "fal-ai/minimax/speech-02-hd",
  designEndpoint: "fal-ai/minimax/voice-design",
  presets: [
    "Wise_Woman",
    "Friendly_Person",
    "Inspirational_girl",
    "Deep_Voice_Man",
    "Calm_Woman",
    "Casual_Guy",
    "Lively_Girl",
    "Patient_Man",
    "Young_Knight",
    "Determined_Man",
    "Lovely_Girl",
    "Decent_Boy",
    "Imposing_Manner",
    "Elegant_Man",
    "Abbess",
    "Sweet_Girl_2",
    "Exuberant_Girl",
  ],
  // voice_id also accepts a designed custom id, so the preset list is a sample.
  presetsClosed: false,
  defaultPreset: "Wise_Woman",
  buildSpeechInput: (input) => ({
    text: input.text,
    voice_setting: {
      voice_id: input.voiceRef,
      ...(input.emotion ? { emotion: input.emotion } : {}),
    },
  }),
  buildDesignInput: (input) => ({ prompt: input.prompt, preview_text: input.previewText }),
  extractVoiceId: extractMinimaxVoiceId,
};

/** ElevenLabs Turbo: preset-only. `voice` is a free-form name (curated sample
 * below); no emotion field, so emotion is ignored. */
const ELEVENLABS: VoiceModel = {
  key: "elevenlabs",
  label: "ElevenLabs Turbo v2.5",
  description: "Preset voices only; low-latency, natural English. Emotion is not supported.",
  speechEndpoint: "fal-ai/elevenlabs/tts/turbo-v2.5",
  presets: [
    "Rachel",
    "Adam",
    "Antoni",
    "Arnold",
    "Bella",
    "Domi",
    "Elli",
    "Josh",
    "Sam",
    "Charlie",
    "Charlotte",
    "Daniel",
    "Emily",
    "George",
    "Lily",
  ],
  presetsClosed: false,
  defaultPreset: "Rachel",
  buildSpeechInput: (input) => ({ text: input.text, voice: input.voiceRef }),
};

/** Bytedance Seed Speech: preset-only with a closed voice enum; emotion is steered
 * via a natural-language `voice_instruction` rather than a fixed field. */
const SEED_SPEECH: VoiceModel = {
  key: "seed-speech",
  label: "Bytedance Seed Speech",
  description: "Preset voices only (closed set); emotion steers delivery via an instruction.",
  speechEndpoint: "fal-ai/bytedance/seed-speech/tts/v2",
  presets: [
    "stokie_en",
    "dacey_en",
    "tim_en",
    "kian_en_zh",
    "cedric_en_zh",
    "sophie_en_zh",
    "jean_en_zh",
    "magnus_en_zh",
    "mabel_en_zh",
    "nadia_en_zh",
    "opal_en_zh",
    "pearl_en_zh",
    "quentin_en_zh",
    "vienna_mixed_en_zh",
    "alina_mixed_en_zh",
    "corinne_mixed_en_zh",
    "esther_mixed_en_zh",
    "freya_mixed_en_zh",
    "gigi_mixed_en_zh",
    "holly_mixed_en_zh",
    "lyla_mixed_en_zh",
    "daisy_mixed_en_zh",
    "vivi_mixed_en_zh_ja_es_id",
    "mindy_en_es_id_pt_zh",
    "sven_de",
    "usseau_fr",
    "felipe_es",
    "enzo_it",
    "shane_ko",
    "minimi_ja",
  ],
  presetsClosed: true,
  defaultPreset: "stokie_en",
  buildSpeechInput: (input) => ({
    text: input.text,
    voice: input.voiceRef,
    ...(input.emotion ? { voice_instruction: `Speak in a ${input.emotion} tone.` } : {}),
  }),
};

/** The registry, keyed by `voice.model`. Ordered most-capable first for listings. */
export const VOICE_MODELS: Readonly<Record<string, VoiceModel>> = {
  [MINIMAX.key]: MINIMAX,
  [ELEVENLABS.key]: ELEVENLABS,
  [SEED_SPEECH.key]: SEED_SPEECH,
};

/** Model used when a profile names none. */
export const DEFAULT_VOICE_MODEL = "minimax";

/** The `voice` block on a profile, read defensively — profiles are permissive
 * JSON, so a malformed block is treated as absent. (The public `VoicePreference`
 * shape lives in types.ts, on `CharacterProfile.voice`.) */
function readVoicePreference(profile: CharacterProfile): { model?: string; preset?: string } {
  const voice = profile.voice;
  if (voice === null || typeof voice !== "object" || Array.isArray(voice)) return {};
  const { model, preset } = voice as Record<string, unknown>;
  return {
    ...(typeof model === "string" && model.trim().length > 0 ? { model: model.trim() } : {}),
    ...(typeof preset === "string" && preset.trim().length > 0 ? { preset: preset.trim() } : {}),
  };
}

/** The profile's chosen preset voice, or undefined (design path). */
export function readVoicePreset(profile: CharacterProfile): string | undefined {
  return readVoicePreference(profile).preset;
}

/**
 * The voice model a profile selects (its `voice.model`, else the default).
 * Throws a listing error on an unknown key so authoring mistakes surface early.
 */
export function resolveVoiceModel(profile: CharacterProfile): VoiceModel {
  const key = readVoicePreference(profile).model ?? DEFAULT_VOICE_MODEL;
  const model = VOICE_MODELS[key];
  if (!model) {
    throw new Error(
      `Unknown voice model "${key}". Available models: ${Object.keys(VOICE_MODELS).join(", ")}.`,
    );
  }
  return model;
}

/**
 * Validates a preset against a model's known voices: for a closed-enum model an
 * unknown preset is a hard error (with the full list); for an open model any
 * name is allowed. Returns the preset unchanged when acceptable.
 */
export function validatePreset(model: VoiceModel, preset: string): string {
  if (model.presetsClosed && !model.presets.includes(preset)) {
    throw new Error(
      `Unknown preset "${preset}" for voice model "${model.key}". Available presets: ${model.presets.join(", ")}.`,
    );
  }
  return preset;
}
