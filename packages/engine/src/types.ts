// Shared domain types for the character-gen engine.
// Kept free of runtime values that TypeScript's erasableSyntaxOnly would reject
// (no enums/namespaces); string unions + `as const` arrays instead.

/** The 8 turnaround angles, in 45° increments. */
export const TURNAROUND_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export type TurnaroundAngle = (typeof TURNAROUND_ANGLES)[number];

/** Every asset kind the pipeline can produce, stored in `assets.kind`. */
export const ASSET_KINDS = [
  "master",
  "expression",
  "outfit",
  "angle_0",
  "angle_45",
  "angle_90",
  "angle_135",
  "angle_180",
  "angle_225",
  "angle_270",
  "angle_315",
  "voice_sample",
  "speech",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** Pipeline steps whose progress we track per character. */
export const PIPELINE_STEPS = ["profile", "sheet", "turnaround", "voice", "publish"] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_STATES = ["pending", "running", "done", "error"] as const;

export type StepState = (typeof STEP_STATES)[number];

/** Per-step status blob persisted as JSON in `characters.status`. */
export type CharacterStatus = Record<PipelineStep, StepState>;

export function emptyStatus(): CharacterStatus {
  return {
    profile: "pending",
    sheet: "pending",
    turnaround: "pending",
    voice: "pending",
    publish: "pending",
  };
}

/**
 * The character profile Claude authors in the skill flow. Only `name` and
 * `identifier` are load-bearing for the engine; the rest is free-form canon the
 * image/voice prompts consume, so it is intentionally permissive.
 */
export interface CharacterProfile {
  name: string;
  identifier: string;
  archetype?: string;
  personality?: string;
  backstory?: string;
  /** Locked physical description reused verbatim in every image prompt. */
  visualCanon?: string;
  voiceDescription?: string;
  [key: string]: unknown;
}

export interface CharacterRecord {
  id: string;
  identifier: string;
  name: string;
  profile: CharacterProfile;
  status: CharacterStatus;
  falCharacterId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AssetRecord {
  id: string;
  characterId: string;
  kind: AssetKind;
  falRequestId: string | null;
  url: string | null;
  localPath: string | null;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

/** Which source supplied the resolved fal API key. */
export type KeySource = "env" | "genmedia" | "config";

export type KeyResolution =
  | { ok: true; key: string; source: KeySource }
  | { ok: false; key: null; source: null };
