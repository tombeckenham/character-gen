// The data contract between the engine's gallery writer and the gallery SPA,
// plus the pure poll/re-render logic the SPA runs every tick. This module is
// bundled into the browser build via the `@character-gen/engine/gallery-data`
// subpath export, so it must stay free of node imports (and of the engine
// barrel, which links node:sqlite).
import { ASSET_KINDS, PIPELINE_STEPS, STEP_STATES } from "./types.ts";
import type { AssetKind, CharacterStatus, StepState } from "./types.ts";

// Re-exported so the SPA can import everything it needs from this one subpath
// (including what the turnaround spinner consumes) without touching the engine
// barrel, which links node modules.
export {
  angleFromKind,
  angleKind,
  ASSET_KINDS,
  PIPELINE_STEPS,
  STEP_STATES,
  TURNAROUND_ANGLES,
} from "./types.ts";
export type {
  AngleKind,
  AssetKind,
  CharacterStatus,
  PipelineStep,
  StepState,
  TurnaroundAngle,
} from "./types.ts";

/** How often the gallery page re-injects `data.js` looking for a new version. */
export const POLL_INTERVAL_MS = 2000;

/** The global the writer declares and the page reads: `window.CHARGEN_DATA`. */
export const DATA_GLOBAL = "CHARGEN_DATA";

/** One publishable media file: its asset kind and a gallery-relative path
 * (`media/<identifier>/<file>`) that resolves on `file://`. */
export interface GalleryAssetEntry {
  kind: AssetKind;
  path: string;
}

export interface GalleryCharacter {
  identifier: string;
  name: string;
  archetype?: string;
  personality?: string;
  backstory?: string;
  visualCanon?: string;
  voiceDescription?: string;
  status: CharacterStatus;
  assets: GalleryAssetEntry[];
}

export interface GalleryData {
  /** Strictly increases on every writer run; the page re-renders on change. */
  version: number;
  characters: GalleryCharacter[];
}

function isStepState(value: unknown): value is StepState {
  return typeof value === "string" && (STEP_STATES as readonly string[]).includes(value);
}

/** Coerces a raw status blob to a full CharacterStatus, defaulting to pending. */
function parseStatus(raw: unknown): CharacterStatus {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const status = {} as CharacterStatus;
  for (const step of PIPELINE_STEPS) {
    const value = source[step];
    status[step] = isStepState(value) ? value : "pending";
  }
  return status;
}

function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === "string" && (ASSET_KINDS as readonly string[]).includes(value);
}

function parseAssets(raw: unknown): GalleryAssetEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GalleryAssetEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const { kind, path } = item as Record<string, unknown>;
    if (!isAssetKind(kind) || typeof path !== "string" || path.length === 0) continue;
    entries.push({ kind, path });
  }
  return entries;
}

/** The free-form profile fields the gallery carries; the writer and the parser
 * both consume this single list so the contract cannot drift. */
export const OPTIONAL_PROFILE_FIELDS = [
  "archetype",
  "personality",
  "backstory",
  "visualCanon",
  "voiceDescription",
] as const;

function parseCharacter(raw: unknown): GalleryCharacter | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const identifier = source["identifier"];
  const name = source["name"];
  if (typeof identifier !== "string" || identifier.length === 0) return null;
  if (typeof name !== "string" || name.length === 0) return null;
  const character: GalleryCharacter = {
    identifier,
    name,
    status: parseStatus(source["status"]),
    assets: parseAssets(source["assets"]),
  };
  for (const field of OPTIONAL_PROFILE_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0) character[field] = value;
  }
  return character;
}

/**
 * Validates the raw `window.CHARGEN_DATA` value into a GalleryData, or null when
 * the top-level shape is unusable. Malformed character/asset entries are dropped
 * rather than failing the whole payload, so one bad row can't blank the gallery.
 */
export function parseGalleryData(raw: unknown): GalleryData | null {
  if (raw === null || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const version = source["version"];
  // The writer's version counter only ever emits positive integers; anything
  // else is a corrupt/foreign payload.
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (!Array.isArray(source["characters"])) return null;
  const characters: GalleryCharacter[] = [];
  for (const entry of source["characters"]) {
    const character = parseCharacter(entry);
    if (character) characters.push(character);
  }
  return { version, characters };
}

export interface PollOutcome {
  /** The data the page should render after this tick. */
  data: GalleryData | null;
  /** True when `data` is a new payload the page must re-render. */
  changed: boolean;
  /** True when the tick delivered a parseable payload at all — false means the
   * file was missing, torn, or foreign, and the page is going stale. */
  valid: boolean;
}

/**
 * One poll tick, as a pure function: given the currently rendered data and the
 * freshly loaded `window.CHARGEN_DATA` value, decide whether to re-render. An
 * unparseable payload (file missing or mid-write) keeps the current data. Any
 * version different from the current one re-renders — including a lower one,
 * so a writer whose counter was reset un-freezes an open page. An unchanged
 * `version` keeps the current object identity, making a state set with it a
 * no-op.
 */
export function reduceGalleryPoll(current: GalleryData | null, raw: unknown): PollOutcome {
  const incoming = parseGalleryData(raw);
  if (!incoming) return { data: current, changed: false, valid: false };
  if (current !== null && incoming.version === current.version) {
    return { data: current, changed: false, valid: true };
  }
  return { data: incoming, changed: true, valid: true };
}
