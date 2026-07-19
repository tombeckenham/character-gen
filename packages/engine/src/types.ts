// Shared domain types for the character-gen engine.
// No enums/namespaces — erasableSyntaxOnly rejects them; string unions + `as
// const` arrays instead.

export const TURNAROUND_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export type TurnaroundAngle = (typeof TURNAROUND_ANGLES)[number];

/** Asset kinds for the 8 turnaround frames, e.g. `angle_45`. */
export type AngleKind = `angle_${TurnaroundAngle}`;

/** The `assets.kind` string union — angle members derived from TURNAROUND_ANGLES. */
export const ASSET_KINDS = [
  "master",
  "expression",
  "outfit",
  ...TURNAROUND_ANGLES.map((angle) => `angle_${angle}` as const),
  "voice_sample",
  "speech",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** The asset kind for a given turnaround angle. */
export function angleKind(angle: TurnaroundAngle): AngleKind {
  return `angle_${angle}`;
}

/** The turnaround angle encoded in an `angle_*` kind, or null if it isn't one. */
export function angleFromKind(kind: string): TurnaroundAngle | null {
  const match = /^angle_(\d+)$/u.exec(kind);
  if (!match) return null;
  const angle = Number(match[1]);
  return (TURNAROUND_ANGLES as readonly number[]).includes(angle)
    ? (angle as TurnaroundAngle)
    : null;
}

/** Pipeline steps whose progress we track per character. */
export const PIPELINE_STEPS = ["profile", "sheet", "turnaround", "voice", "publish"] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/**
 * The subset of PIPELINE_STEPS that `create` can actually run today. The rest of
 * PIPELINE_STEPS are recognized (for clear "not built yet" errors) but not
 * implemented. This is the single list a future phase flips a step on in.
 */
export const IMPLEMENTED_STEPS = [
  "profile",
  "sheet",
  "turnaround",
] as const satisfies readonly PipelineStep[];

export type ImplementedStep = (typeof IMPLEMENTED_STEPS)[number];

/**
 * What `create` runs when `--steps` is omitted. The turnaround is implemented
 * but costs 8 generations, so it stays opt-in rather than a default.
 */
export const DEFAULT_CREATE_STEPS = ["profile", "sheet"] as const satisfies readonly PipelineStep[];

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
