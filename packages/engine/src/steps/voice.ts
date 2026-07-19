import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { readVoicePreset, resolveVoiceModel, validatePreset } from "./voice-models.ts";
import type { SpeechInput, VoiceDesignInput, VoiceModel } from "./voice-models.ts";

/** A designed voice: the preview clip (as a stored asset) plus the reusable
 * voice id the speech endpoint synthesizes future lines with. */
export interface DesignedVoice extends GeneratedAsset {
  customVoiceId: string;
}

/**
 * The voice step's only fal dependency, injectable so tests run offline. Both
 * methods take the resolved `VoiceModel`, which supplies the endpoint and the
 * input shape — the executor itself stays model-blind. `design` mints a bespoke
 * voice (design-capable models only); `speak` voices a line with a voice id or
 * preset.
 */
export interface VoiceGenerator {
  design(
    model: VoiceModel,
    input: VoiceDesignInput,
    onProgress?: (update: GenProgress) => void,
  ): Promise<DesignedVoice>;
  speak(
    model: VoiceModel,
    input: SpeechInput,
    onProgress?: (update: GenProgress) => void,
  ): Promise<GeneratedAsset>;
}

/**
 * Real `VoiceGenerator` backed by the fal client's queue `subscribe`. Each call
 * routes to the model's endpoint and shapes its input via the model's adapter,
 * so a new model is added in voice-models.ts without touching this executor.
 */
export function makeFalVoiceGenerator(client: FalClient): VoiceGenerator {
  return {
    async design(model, input, onProgress) {
      if (!model.designEndpoint || !model.buildDesignInput || !model.extractVoiceId) {
        throw new Error(
          `Voice model "${model.key}" does not design bespoke voices — set a preset in the profile's "voice" block instead.`,
        );
      }
      const result = await client.subscribe(model.designEndpoint, {
        input: model.buildDesignInput(input),
        ...(onProgress ? { onQueueUpdate: onProgress } : {}),
      });
      return {
        requestId: result.requestId,
        url: extractAudioUrl(result.data),
        customVoiceId: model.extractVoiceId(result.data),
      };
    },
    async speak(model, input, onProgress) {
      const result = await client.subscribe(model.speechEndpoint, {
        input: model.buildSpeechInput(input),
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
 * The prompt that shapes a designed voice: the authored `voiceDescription`
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

/** The sample line the voice step speaks back to preview the voice. */
export function buildPreviewText(profile: CharacterProfile): string {
  return `Hello. I am ${profile.name}. This is the sound of my voice — remember it well.`;
}

export interface RunVoiceDeps extends StepMediaDeps {
  generator: VoiceGenerator;
}

export interface VoiceOutcome {
  sample: AssetRecord;
  /** The voice model used (registry key). */
  model: string;
  /** The designed custom voice id (design path) or the preset name (preset path). */
  voiceRef: string;
  /** True when a bespoke voice was designed; false when a stock preset was used. */
  designed: boolean;
}

/**
 * Establishes the character's voice, downloading a preview clip to
 * `characters/<identifier>/` and recording a `voice_sample` asset. Two paths,
 * both driven by the profile's `voice` block:
 *
 * - **Preset** (a `voice.preset` is set, or the chosen model can't design):
 *   validates the preset and synthesizes the preview line with it, so an open
 *   gallery still gets a sample. The sample's meta carries the preset + model.
 * - **Design** (a design-capable model with no preset): mints a bespoke voice
 *   from the voice description; the sample's meta carries the `customVoiceId`.
 *
 * Marks the `voice` status running → done; on failure marks it `error` and
 * rethrows. Bad input (unknown model/preset, or a design path with no voice
 * description) throws before the step is marked running.
 */
export async function runVoice(
  character: CharacterRecord,
  deps: RunVoiceDeps,
): Promise<VoiceOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.store, "voice");
  const profile = character.profile;

  const model = resolveVoiceModel(profile);
  const preset = readVoicePreset(profile);
  const previewText = buildPreviewText(profile);

  // Preset path: a chosen preset, or a model that can only speak from presets.
  if (preset !== undefined || !model.designEndpoint) {
    const chosen = preset === undefined ? model.defaultPreset : validatePreset(model, preset);
    return await withStepStatus(deps.store, character.id, "voice", report, async () => {
      report(`voice: previewing ${model.label} preset "${chosen}"…`);
      const audio = await deps.generator.speak(
        model,
        { text: previewText, voiceRef: chosen },
        (u) => report(`voice: ${u.status.toLowerCase()}`),
      );
      const sample = await storeAsset({
        deps,
        character,
        charDir,
        kind: "voice_sample",
        fileName: "voice-sample.mp3",
        image: audio,
        meta: { endpoint: model.speechEndpoint, model: model.key, preset: chosen, previewText },
      });
      return { sample, model: model.key, voiceRef: chosen, designed: false };
    });
  }

  // Design path: mint a bespoke voice from the description.
  const prompt = buildVoiceDesignPrompt(profile);
  if (prompt === null) {
    throw new Error(
      `No voice description for "${character.identifier}" — add a "voiceDescription" to its profile, or set a stock voice via "voice": { "model": "...", "preset": "..." }, then retry.`,
    );
  }
  return await withStepStatus(deps.store, character.id, "voice", report, async () => {
    report(`voice: designing signature ${model.label} voice…`);
    const voice = await deps.generator.design(model, { prompt, previewText }, (u) =>
      report(`voice: ${u.status.toLowerCase()}`),
    );
    const sample = await storeAsset({
      deps,
      character,
      charDir,
      kind: "voice_sample",
      fileName: "voice-sample.mp3",
      image: voice,
      meta: {
        endpoint: model.designEndpoint,
        model: model.key,
        customVoiceId: voice.customVoiceId,
        prompt,
        previewText,
      },
    });
    return { sample, model: model.key, voiceRef: voice.customVoiceId, designed: true };
  });
}

/**
 * The `custom_voice_id` of the character's designed voice: the newest
 * `voice_sample` asset carrying one in its meta (assets are ordered
 * oldest-first). Null when no bespoke voice has been designed (e.g. a
 * preset-only character).
 */
export async function findDesignedVoiceId(
  store: StepMediaDeps["store"],
  characterId: string,
): Promise<string | null> {
  const assets = await store.getAssets(characterId);
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
  emotion?: SpeechInput["emotion"];
}

export interface SpeakOutcome {
  speech: AssetRecord;
}

/**
 * The voice reference `speak` synthesizes with: the profile's preset wins; else
 * a previously designed bespoke voice; else a preset-only model's default (with
 * a note). A design-capable model with none of these is an error — the user must
 * design a voice or name a preset first.
 */
async function resolveSpeakVoiceRef(
  character: CharacterRecord,
  model: VoiceModel,
  preset: string | undefined,
  store: StepMediaDeps["store"],
  report: (message: string) => void,
): Promise<string> {
  if (preset !== undefined) return validatePreset(model, preset);
  const designed = await findDesignedVoiceId(store, character.id);
  if (designed !== null) return designed;
  if (!model.designEndpoint) {
    report(
      `speak: no voice chosen — using ${model.label} default preset "${model.defaultPreset}".`,
    );
    return model.defaultPreset;
  }
  throw new Error(
    `No designed voice for "${character.identifier}" — run \`character-gen voice ${character.identifier}\` first, or set "voice": { "preset": "…" } in its profile.`,
  );
}

/**
 * Voices a line in the character's voice, downloading the clip to
 * `characters/<identifier>/speech-<n>.mp3` and recording a `speech` asset. The
 * voice used is resolved from the profile: a `voice.preset` wins; otherwise a
 * previously designed bespoke voice; otherwise a preset-only model falls back to
 * its default preset. A design-capable model with neither is an error (run
 * `voice` first, or set a preset). Each clip gets a distinct sequence number so
 * successive lines never overwrite one another. Not a tracked pipeline step, so
 * it leaves statuses untouched.
 */
export async function runSpeak(
  character: CharacterRecord,
  deps: RunSpeakDeps,
): Promise<SpeakOutcome> {
  const report = dedupedReporter(deps.onProgress);
  const charDir = ensureCharacterMediaDir(character, deps.store, "voice");
  const profile = character.profile;

  const line = deps.line.trim();
  if (line.length === 0) {
    throw new Error("Nothing to speak — provide a non-empty line.");
  }

  const model = resolveVoiceModel(profile);
  const voiceRef = await resolveSpeakVoiceRef(
    character,
    model,
    readVoicePreset(profile),
    deps.store,
    report,
  );

  report("speak: synthesizing…");
  const audio = await deps.generator.speak(
    model,
    { text: line, voiceRef, ...(deps.emotion ? { emotion: deps.emotion } : {}) },
    (update) => report(`speak: ${update.status.toLowerCase()}`),
  );
  const assets = await deps.store.getAssets(character.id);
  let seq = assets.filter((asset) => asset.kind === "speech").length + 1;
  // Skip files already on disk (e.g. a hand-pruned character.json) so a new
  // clip never overwrites an earlier one.
  while (existsSync(join(charDir, `speech-${seq}.mp3`))) seq += 1;
  const speech = await storeAsset({
    deps,
    character,
    charDir,
    kind: "speech",
    fileName: `speech-${seq}.mp3`,
    image: audio,
    meta: {
      endpoint: model.speechEndpoint,
      model: model.key,
      text: line,
      voiceRef,
      ...(deps.emotion ? { emotion: deps.emotion } : {}),
    },
  });
  return { speech };
}
