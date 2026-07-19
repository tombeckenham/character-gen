import type { FalClient } from "../fal.ts";
import type { AssetRecord, CharacterProfile, CharacterRecord } from "../types.ts";
import {
  dedupedReporter,
  ensureCharacterMediaDir,
  extractAudioUrl,
  storeAsset,
  withStepStatus,
} from "./common.ts";
import type { GeneratedAsset, GenProgress, StepMediaDeps } from "./common.ts";

/** Designs the character's signature voice; the speech model voices any line. */
export const VOICE_DESIGN_ENDPOINT = "fal-ai/minimax/voice-design";
export const SPEECH_ENDPOINT = "fal-ai/minimax/speech-02-hd";

/** The emotions the speech endpoint's `voice_setting.emotion` accepts. */
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
  /** The designed `custom_voice_id` to synthesize with. */
  voiceId: string;
  emotion?: SpeechEmotion;
}

/** A designed voice: the preview clip (as a stored asset) plus the reusable
 * `custom_voice_id` the speech endpoint synthesizes future lines with. */
export interface DesignedVoice extends GeneratedAsset {
  customVoiceId: string;
}

/** The voice step's only fal dependency, injectable so tests run offline.
 * `design` mints the signature voice; `speak` voices a line with it. */
export interface VoiceGenerator {
  design(
    input: VoiceDesignInput,
    onProgress?: (update: GenProgress) => void,
  ): Promise<DesignedVoice>;
  speak(input: SpeechInput, onProgress?: (update: GenProgress) => void): Promise<GeneratedAsset>;
}

/** Pulls the `custom_voice_id` out of a voice-design response, or throws. */
function extractCustomVoiceId(data: unknown): string {
  const id = (data as { custom_voice_id?: unknown }).custom_voice_id;
  if (typeof id === "string" && id.length > 0) return id;
  throw new Error("fal voice-design response contained no custom_voice_id");
}

/**
 * Real `VoiceGenerator` backed by the fal client's queue `subscribe`. Conforms
 * to the verified schemas: voice-design takes `prompt` + `preview_text` and
 * returns `custom_voice_id` + `audio`; speech-02-hd takes `text` +
 * `voice_setting` and returns `audio`.
 */
export function makeFalVoiceGenerator(client: FalClient): VoiceGenerator {
  return {
    async design(input, onProgress) {
      const result = await client.subscribe(VOICE_DESIGN_ENDPOINT, {
        input: { prompt: input.prompt, preview_text: input.previewText },
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return {
        requestId: result.requestId,
        url: extractAudioUrl(result.data),
        customVoiceId: extractCustomVoiceId(result.data),
      };
    },
    async speak(input, onProgress) {
      const result = await client.subscribe(SPEECH_ENDPOINT, {
        input: {
          text: input.text,
          voice_setting: {
            voice_id: input.voiceId,
            ...(input.emotion ? { emotion: input.emotion } : {}),
          },
        },
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return { requestId: result.requestId, url: extractAudioUrl(result.data) };
    },
  };
}

/** Non-empty trimmed value of a free-form profile string field, or "". */
function trimmedField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The prompt that shapes the designed voice: the authored `voiceDescription`
 * verbatim when present, else one composed from archetype/personality. Null when
 * the profile carries none of those — the caller turns that into a clear error
 * rather than minting a random voice from nothing.
 */
export function buildVoiceDesignPrompt(profile: CharacterProfile): string | null {
  const voice = trimmedField(profile.voiceDescription);
  if (voice) return voice;
  const traits = [trimmedField(profile.archetype), trimmedField(profile.personality)].filter(
    (part) => part.length > 0,
  );
  return traits.length > 0 ? `A distinctive character voice for ${traits.join(", ")}.` : null;
}

/** The sample line the design endpoint speaks back to preview the voice. */
export function buildPreviewText(profile: CharacterProfile): string {
  return `Hello. I am ${profile.name}. This is the sound of my voice — remember it well.`;
}

export interface RunVoiceDeps extends StepMediaDeps {
  generator: VoiceGenerator;
}

export interface VoiceOutcome {
  sample: AssetRecord;
  customVoiceId: string;
}

/**
 * Designs the character's signature voice from its voice description,
 * downloading the preview clip to `<mediaDir>/<identifier>/` and recording a
 * `voice_sample` asset whose meta carries the reusable `custom_voice_id` (which
 * `speak` reads). Marks the `voice` status running → done; on failure marks it
 * `error` and rethrows. Requires a profile with a voice description (or an
 * archetype/personality to compose one from).
 */
export async function runVoice(
  character: CharacterRecord,
  deps: RunVoiceDeps,
): Promise<VoiceOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.mediaDir, "voice");

  const prompt = buildVoiceDesignPrompt(character.profile);
  if (prompt === null) {
    throw new Error(
      `No voice description for "${character.identifier}" — add a "voiceDescription" to its profile, then retry.`,
    );
  }
  const previewText = buildPreviewText(character.profile);

  return await withStepStatus(deps.db, character.id, "voice", report, async () => {
    report("voice: designing signature voice…");
    const voice = await deps.generator.design({ prompt, previewText }, (update) =>
      report(`voice: ${update.status.toLowerCase()}`),
    );
    const sample = await storeAsset({
      deps,
      character,
      charDir,
      kind: "voice_sample",
      fileName: "voice-sample.mp3",
      image: voice,
      meta: {
        endpoint: VOICE_DESIGN_ENDPOINT,
        customVoiceId: voice.customVoiceId,
        prompt,
        previewText,
      },
    });
    return { sample, customVoiceId: voice.customVoiceId };
  });
}

/**
 * The `custom_voice_id` of the character's designed voice: the newest
 * `voice_sample` asset carrying one in its meta (assets are ordered
 * oldest-first). Null when the voice step has not produced a usable one.
 */
export async function findDesignedVoiceId(
  db: StepMediaDeps["db"],
  characterId: string,
): Promise<string | null> {
  const assets = await db.getAssets(characterId);
  for (let i = assets.length - 1; i >= 0; i -= 1) {
    const asset = assets[i];
    if (asset && asset.kind === "voice_sample" && asset.meta) {
      const id = asset.meta["customVoiceId"];
      if (typeof id === "string" && id.length > 0) return id;
    }
  }
  return null;
}

export interface RunSpeakDeps extends StepMediaDeps {
  generator: VoiceGenerator;
  /** The line to voice. */
  line: string;
  emotion?: SpeechEmotion;
}

export interface SpeakOutcome {
  speech: AssetRecord;
}

/**
 * Voices a line in the character's designed voice, downloading the clip to
 * `<mediaDir>/<identifier>/speech-<n>.mp3` and recording a `speech` asset. Each
 * clip gets a distinct sequence number (an atomic per-character counter) so
 * successive lines never overwrite one another. Requires a designed voice (run
 * `voice` first); this is not a tracked pipeline step, so it leaves statuses
 * untouched.
 */
export async function runSpeak(
  character: CharacterRecord,
  deps: RunSpeakDeps,
): Promise<SpeakOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.mediaDir, "voice");

  const line = deps.line.trim();
  if (line.length === 0) {
    throw new Error("Nothing to speak — provide a non-empty line.");
  }
  const voiceId = await findDesignedVoiceId(deps.db, character.id);
  if (voiceId === null) {
    throw new Error(
      `No designed voice for "${character.identifier}" — run \`character-gen voice ${character.identifier}\` first.`,
    );
  }

  report("speak: synthesizing…");
  const audio = await deps.generator.speak(
    { text: line, voiceId, ...(deps.emotion ? { emotion: deps.emotion } : {}) },
    (update) => report(`speak: ${update.status.toLowerCase()}`),
  );
  const seq = await deps.db.bumpCounter(`speech_seq:${character.id}`);
  const speech = await storeAsset({
    deps,
    character,
    charDir,
    kind: "speech",
    fileName: `speech-${seq}.mp3`,
    image: audio,
    meta: {
      endpoint: SPEECH_ENDPOINT,
      text: line,
      voiceId,
      ...(deps.emotion ? { emotion: deps.emotion } : {}),
    },
  });
  return { speech };
}
