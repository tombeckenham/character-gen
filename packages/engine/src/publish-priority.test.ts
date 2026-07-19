import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prioritizeReferenceAssets,
  REFERENCE_IMAGE_CAP,
  referenceRank,
} from "./publish-priority.ts";

/** The full-tier asset roster in generation order: 23 images + 2 audio. */
const FULL_ROSTER = [
  "master",
  "expression",
  "outfit",
  "face_front",
  "face_three_quarter",
  "face_profile",
  "expression",
  "expression",
  "expression",
  "detail",
  "detail",
  "detail",
  "detail",
  "scale",
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
].map((kind, index) => ({ kind, id: index }));

test("referenceRank orders faces > master > scale > expression > detail > cardinal angles > outfit > other angles", () => {
  const order = [
    "face_front",
    "master",
    "scale",
    "expression",
    "detail",
    "angle_0",
    "outfit",
    "angle_45",
    "voice_sample",
  ].map((kind) => referenceRank(kind));
  assert.deepEqual(
    order,
    [...order].toSorted((a, b) => a - b),
  );
  assert.equal(referenceRank("angle_90"), referenceRank("angle_180"));
  assert.ok(referenceRank("angle_135") > referenceRank("outfit"));
});

test("prioritizeReferenceAssets caps a full roster at 20, dropping the right tail", () => {
  const chosen = prioritizeReferenceAssets(FULL_ROSTER);
  assert.equal(chosen.length, REFERENCE_IMAGE_CAP);
  const kinds = chosen.map((asset) => asset.kind);
  // Everything identity-bearing made the cut…
  assert.deepEqual(kinds.slice(0, 3), ["face_front", "face_three_quarter", "face_profile"]);
  assert.ok(kinds.includes("master"));
  assert.ok(kinds.includes("scale"));
  assert.equal(kinds.filter((kind) => kind === "expression").length, 4);
  assert.equal(kinds.filter((kind) => kind === "detail").length, 4);
  // 18 slots go to faces/master/scale/expressions/details/cardinals/outfit; the
  // remaining 2 go to the first non-cardinal angles in generation order.
  assert.deepEqual(
    kinds.filter((kind) => kind.startsWith("angle_")),
    ["angle_0", "angle_90", "angle_180", "angle_270", "angle_45", "angle_135"],
  );
  assert.ok(kinds.includes("outfit"));
  // …and the trailing non-cardinal angles + audio kinds were dropped.
  assert.ok(!kinds.includes("angle_225"));
  assert.ok(!kinds.includes("angle_315"));
  assert.ok(!kinds.includes("voice_sample"));
});

test("prioritizeReferenceAssets is stable within a rank (generation order)", () => {
  const expressions = FULL_ROSTER.filter((asset) => asset.kind === "expression");
  const chosen = prioritizeReferenceAssets(FULL_ROSTER).filter(
    (asset) => asset.kind === "expression",
  );
  assert.deepEqual(
    chosen.map((asset) => asset.id),
    expressions.map((asset) => asset.id),
  );
});

test("prioritizeReferenceAssets under cap keeps everything, reordered", () => {
  const few = [{ kind: "outfit" }, { kind: "master" }, { kind: "face_front" }];
  assert.deepEqual(
    prioritizeReferenceAssets(few).map((asset) => asset.kind),
    ["face_front", "master", "outfit"],
  );
  assert.deepEqual(prioritizeReferenceAssets(few, 0), []);
});
