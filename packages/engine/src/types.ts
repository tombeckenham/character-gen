// Shared domain types for the character-gen engine.
// No enums/namespaces — erasableSyntaxOnly rejects them; string unions + `as
// const` arrays instead.

export const TURNAROUND_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export type TurnaroundAngle = (typeof TURNAROUND_ANGLES)[number];

/** Asset kinds for the 8 turnaround frames, e.g. `angle_45`. */
export type AngleKind = `angle_${TurnaroundAngle}`;

/** The three dedicated face views, in display (triptych) order. */
export const FACE_KINDS = ["face_front", "face_three_quarter", "face_profile"] as const;

export type FaceKind = (typeof FACE_KINDS)[number];

/** The `assets.kind` string union — angle members derived from TURNAROUND_ANGLES. */
export const ASSET_KINDS = [
  "master",
  "expression",
  "outfit",
  ...FACE_KINDS,
  "detail",
  "scale",
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

/**
 * The rich-sheet generation passes, in canonical run order. Each pass is a
 * separate invocation over the shared step core, but all of them roll up into
 * the existing `sheet` pipeline step.
 */
export const SHEET_PASSES = ["face", "expressions", "details", "scale"] as const;

export type SheetPass = (typeof SHEET_PASSES)[number];

/** Sheet richness tiers — the CLI/skill vocabulary for how much to generate. */
export const SHEET_TIERS = ["core", "rich", "full"] as const;

export type SheetTier = (typeof SHEET_TIERS)[number];

/** The extra passes each tier runs after the core sheet. */
export const TIER_PASSES: Record<SheetTier, readonly SheetPass[]> = {
  core: [],
  rich: ["face", "expressions", "details"],
  full: ["face", "expressions", "details", "scale"],
};

/** Detail-macro budget per tier (hands + imperfection/prop macros). */
export const TIER_DETAIL_CAP: Record<SheetTier, number> = {
  core: 0,
  rich: 2,
  full: 4,
};

/** Detail-macro cap when `--passes details` is invoked without a tier. */
export const MAX_DETAIL_MACROS = 4;

/** The expression set generated when a profile does not name its own. */
export const DEFAULT_EXPRESSIONS = ["joy", "anger", "fear", "exhaustion"] as const;

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
 * What `create` runs when `--steps` is omitted. The turnaround (8 generations)
 * is part of the default experience — a character isn't done until you can
 * spin them; skip it with an explicit `--steps profile,sheet`.
 */
export const DEFAULT_CREATE_STEPS = [
  "profile",
  "sheet",
  "turnaround",
] as const satisfies readonly PipelineStep[];

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

/** Structured physical traits — every field optional prose except height. */
export interface PhysicalTraits {
  apparentAge?: string;
  build?: string;
  heightCm?: number;
  skin?: string;
  eyes?: string;
  hair?: string;
  face?: string;
}

/**
 * One identity-anchoring imperfection: what it is, where it sits, and the story
 * behind it. Models keep a chipped tooth or a mended seam consistent far more
 * reliably than generic prose, so each one is injected into every image prompt
 * and gets its own macro shot in the `details` pass.
 */
export interface Imperfection {
  what: string;
  where: string;
  story?: string;
}

/** How the character moves and rests — consumed by video prompts later. */
export interface MotionTraits {
  gait?: string;
  posture?: string;
  restingFace?: string;
  habit?: string;
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
  physical?: PhysicalTraits;
  imperfections?: Imperfection[];
  /** Props/garments the character always carries or wears. */
  signatureItems?: string[];
  palette?: string[];
  materials?: string[];
  motion?: MotionTraits;
  /** The character's own emotional range; DEFAULT_EXPRESSIONS when absent. */
  expressions?: string[];
  /** Things the character would never look like/do — negative guidance. */
  negativeCanon?: string[];
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
