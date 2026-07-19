// The data contract between the engine's gallery writer and the gallery SPA,
// plus the pure poll/re-render logic the SPA runs every tick. This module is
// bundled into the browser build via the `@character-gen/engine/gallery-data`
// subpath export, so it must stay free of node imports (and of the engine
// barrel, which links node:sqlite).
import { PIPELINE_STEPS, STEP_STATES } from "./types.ts";
import type { AssetKind, CharacterStatus, StepState } from "./types.ts";

// Re-exported so the SPA can import everything it needs from this one subpath.
export { ASSET_KINDS, PIPELINE_STEPS, STEP_STATES } from "./types.ts";
export type { AssetKind, CharacterStatus, PipelineStep, StepState } from "./types.ts";

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

function parseAssets(raw: unknown): GalleryAssetEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GalleryAssetEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const { kind, path } = item as Record<string, unknown>;
    if (typeof kind !== "string" || typeof path !== "string" || path.length === 0) continue;
    entries.push({ kind: kind as AssetKind, path });
  }
  return entries;
}

const OPTIONAL_PROFILE_FIELDS = [
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
  if (typeof version !== "number" || !Number.isFinite(version)) return null;
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
}

/**
 * One poll tick, as a pure function: given the currently rendered data and the
 * freshly loaded `window.CHARGEN_DATA` value, decide whether to re-render. An
 * unparseable payload (file missing or mid-write) keeps the current data; an
 * unchanged `version` keeps the current object identity so React bails out.
 */
export function reduceGalleryPoll(current: GalleryData | null, raw: unknown): PollOutcome {
  const incoming = parseGalleryData(raw);
  if (!incoming) return { data: current, changed: false };
  if (current !== null && incoming.version === current.version) {
    return { data: current, changed: false };
  }
  return { data: incoming, changed: true };
}
