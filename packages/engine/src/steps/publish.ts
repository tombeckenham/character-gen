// The publish step: push a character to the fal Assets Characters API by
// shelling out to the genmedia CLI, which already wraps the full CRUD surface
// (see PLAN.md "fal Assets Characters integration"). We deliberately do not
// hand-roll the HTTP calls — genmedia owns the request/response handling.
import { spawn } from "node:child_process";
import type { AssetRecord, CharacterProfile, CharacterRecord } from "../types.ts";
import { prioritizeReferenceAssets, REFERENCE_IMAGE_CAP } from "../publish-priority.ts";
import { dedupedReporter, withStepStatus } from "./common.ts";
import type { StepMediaDeps } from "./common.ts";

/** The fal Assets Characters API caps `description` at this many characters. */
export const DESCRIPTION_CAP = 2000;

/** Exit/spawn outcome of one genmedia invocation. */
export interface GenmediaResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `genmedia <args>`; injectable so tests never spawn anything. */
export type GenmediaRunner = (args: string[]) => Promise<GenmediaResult>;

export const GENMEDIA_MISSING =
  "The genmedia CLI is required to publish (character-gen shells out to `genmedia assets characters`). Install it and make sure `genmedia` is on PATH, then retry.";

/**
 * Real runner: spawns `genmedia` with the given args, resolving the key env
 * ahead of time so genmedia sees the same FAL_KEY character-gen resolved. A
 * missing binary (ENOENT) surfaces as the actionable GENMEDIA_MISSING error
 * instead of a raw spawn failure.
 */
export function makeGenmediaRunner(env: NodeJS.ProcessEnv = process.env): GenmediaRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      const child = spawn("genmedia", args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(error.code === "ENOENT" ? new Error(GENMEDIA_MISSING, { cause: error }) : error);
      });
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
}

/**
 * The Assets `description` (≤2000 chars, used for semantic matching). Prefers
 * the authored one-line `logline` — a crisp semantic summary is a far better
 * match target than a wall of canon. Falls back to archetype + personality +
 * visual canon, then the free-form description or the name, so it is never empty.
 */
export function buildPublishDescription(profile: CharacterProfile): string {
  const logline = profile.logline;
  if (typeof logline === "string" && logline.trim().length > 0) {
    const trimmed = logline.trim();
    return trimmed.length > DESCRIPTION_CAP ? `${trimmed.slice(0, DESCRIPTION_CAP - 1)}…` : trimmed;
  }
  const description = profile["description"];
  const parts = [
    profile.archetype,
    profile.personality,
    profile.visualCanon,
    typeof description === "string" ? description : undefined,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  const text = parts.length > 0 ? parts.join(". ") : profile.name;
  return text.length > DESCRIPTION_CAP ? `${text.slice(0, DESCRIPTION_CAP - 1)}…` : text;
}

/** Reference-image candidates: image assets with a billed fal request id.
 * Voice/speech assets are audio and must never be sent as references. */
function referenceRequestIds(assets: AssetRecord[]): string[] {
  const images = assets.filter(
    (asset) =>
      asset.falRequestId !== null && asset.kind !== "voice_sample" && asset.kind !== "speech",
  );
  const ids = prioritizeReferenceAssets(images, REFERENCE_IMAGE_CAP).map(
    (asset) => asset.falRequestId as string,
  );
  return [...new Set(ids)];
}

/** The best cover image URL for the asset: the newest portrait close-up, else
 * a front face, else the master sheet. Assets are oldest-first, so scan back to
 * front and take the first match per preferred kind. */
export function findCoverUrl(assets: AssetRecord[]): string | null {
  const newestUrlOfKind = (kind: string): string | null => {
    for (let i = assets.length - 1; i >= 0; i -= 1) {
      const asset = assets[i];
      if (asset && asset.kind === kind && asset.url) return asset.url;
    }
    return null;
  };
  return newestUrlOfKind("portrait") ?? newestUrlOfKind("face_front") ?? newestUrlOfKind("master");
}

/** Parses genmedia's --json output for the created/updated character id. */
function parseCharacterId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { character?: { id?: unknown }; id?: unknown };
    const id = parsed.character?.id ?? parsed.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export interface RunPublishDeps extends Omit<StepMediaDeps, "fetchImpl" | "downloadTimeoutMs"> {
  runGenmedia: GenmediaRunner;
}

export interface PublishOutcome {
  falCharacterId: string;
  referenceCount: number;
  /** True when an existing fal character was updated rather than created. */
  updated: boolean;
}

/** The genmedia argv for this publish — exported for tests and dry inspection. */
export function buildPublishArgs(
  character: CharacterRecord,
  requestIds: string[],
  coverUrl: string | null,
): string[] {
  const shared = [
    "--description",
    buildPublishDescription(character.profile),
    "--reference_image",
    requestIds.join(","),
    ...(coverUrl ? ["--cover_image_url", coverUrl] : []),
    "--idempotency_key",
    `character-gen-${character.id}`,
    "--json",
  ];
  return character.falCharacterId
    ? [
        "assets",
        "characters",
        "update",
        character.falCharacterId,
        "--name",
        character.name,
        ...shared,
      ]
    : [
        "assets",
        "characters",
        "create",
        character.name,
        "--identifier",
        character.identifier,
        ...shared,
      ];
}

/**
 * When a create 409s because the @identifier is taken, the usual cause is our
 * own orphaned earlier create — the Assets API has been observed creating the
 * character server-side and *then* failing the request (e.g. a non-admin key),
 * leaving a fal character we never got the id for. Recover by listing and
 * adopting the character whose identifier matches; null when it isn't there.
 */
async function findFalCharacterIdByIdentifier(
  runGenmedia: GenmediaRunner,
  identifier: string,
): Promise<string | null> {
  const result = await runGenmedia(["assets", "characters", "list", "--json"]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      characters?: Array<{ id?: unknown; character_identifier?: unknown }>;
    };
    const match = parsed.characters?.find((c) => c.character_identifier === identifier);
    return match && typeof match.id === "string" && match.id.length > 0 ? match.id : null;
  } catch {
    return null;
  }
}

/** True for the Assets 409 "identifier already used" validation failure. */
function isIdentifierTakenError(result: GenmediaResult): boolean {
  const text = result.stderr + result.stdout;
  return text.includes("already used by another character") || text.includes("(409)");
}

/**
 * Publishes the character to fal Assets Characters via genmedia: prioritized
 * image request_ids as `reference_images` (≤20), the portrait close-up (else a
 * face, else the master) as the cover, and an idempotency key from the local UUID. Stores the
 * returned fal character id; when one already exists the publish becomes an
 * update (PATCH semantics — the reference set is replaced wholesale). A create
 * that 409s on the identifier adopts the existing fal character and updates it
 * instead. Marks the `publish` step running → done/error.
 */
export async function runPublish(
  character: CharacterRecord,
  deps: RunPublishDeps,
): Promise<PublishOutcome> {
  const report = dedupedReporter(deps.onProgress);

  const assets = await deps.store.getAssets(character.id);
  const requestIds = referenceRequestIds(assets);
  if (requestIds.length === 0) {
    throw new Error(
      `Nothing to publish for "${character.identifier}" — generate a sheet first (\`character-gen sheet ${character.identifier}\`).`,
    );
  }
  const coverUrl = findCoverUrl(assets);

  return withStepStatus(deps.store, character.id, "publish", report, async () => {
    let target = character;
    let updated = target.falCharacterId !== null;
    report(
      `publish: ${updated ? "updating" : "creating"} fal character (${requestIds.length} references)…`,
    );
    let result = await deps.runGenmedia(buildPublishArgs(target, requestIds, coverUrl));

    if (result.status !== 0 && !updated && isIdentifierTakenError(result)) {
      const existingId = await findFalCharacterIdByIdentifier(deps.runGenmedia, target.identifier);
      if (existingId) {
        report(`publish: @${target.identifier} already exists on fal — updating ${existingId}`);
        target = { ...target, falCharacterId: existingId };
        updated = true;
        result = await deps.runGenmedia(buildPublishArgs(target, requestIds, coverUrl));
      }
    }

    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        `genmedia assets characters ${updated ? "update" : "create"} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    const falCharacterId = parseCharacterId(result.stdout) ?? target.falCharacterId;
    if (!falCharacterId) {
      throw new Error(
        `genmedia succeeded but returned no character id — raw output: ${result.stdout.trim().slice(0, 300)}`,
      );
    }
    await deps.store.updateCharacter(character.id, { falCharacterId });
    return { falCharacterId, referenceCount: requestIds.length, updated };
  });
}
