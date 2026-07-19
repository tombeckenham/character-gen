export const ENGINE_VERSION = "0.1.0";

export * from "./types.ts";
export * from "./paths.ts";
export * from "./config.ts";
export * from "./key.ts";
export * from "./fal.ts";
export * from "./setup.ts";
export * from "./doctor.ts";
export * from "./character.ts";
export * from "./canon.ts";
export * from "./publish-priority.ts";
export * from "./steps/sheet.ts";
export * from "./steps/passes.ts";
export * from "./steps/turnaround.ts";
export * from "./steps/voice.ts";
export * from "./gallery.ts";
// gallery-data re-exports types.ts names; explicit exports avoid the ambiguity
// a second `export *` would create for those shared bindings.
export {
  ASSET_ANNOTATION_FIELDS,
  DATA_GLOBAL,
  OPTIONAL_PROFILE_FIELDS,
  parseGalleryData,
  POLL_INTERVAL_MS,
  reduceGalleryPoll,
} from "./gallery-data.ts";
export type {
  GalleryAssetEntry,
  GalleryCharacter,
  GalleryData,
  PollOutcome,
} from "./gallery-data.ts";
export { CHARACTER_FILE, DuplicateIdentifierError, openStore } from "./store/index.ts";
export type { CharacterStore, NewCharacter, NewAsset, CharacterPatch } from "./store/index.ts";
