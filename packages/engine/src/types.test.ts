import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSET_KINDS,
  TURNAROUND_ANGLES,
  angleFromKind,
  angleKind,
  emptyStatus,
  PIPELINE_STEPS,
} from "./types.ts";

test("ASSET_KINDS includes an angle_* member for every turnaround angle", () => {
  for (const angle of TURNAROUND_ANGLES) {
    assert.ok(
      (ASSET_KINDS as readonly string[]).includes(`angle_${angle}`),
      `missing angle_${angle}`,
    );
  }
  assert.ok((ASSET_KINDS as readonly string[]).includes("master"));
  assert.ok((ASSET_KINDS as readonly string[]).includes("voice_sample"));
});

test("angleKind and angleFromKind round-trip", () => {
  for (const angle of TURNAROUND_ANGLES) {
    assert.equal(angleFromKind(angleKind(angle)), angle);
  }
});

test("angleFromKind returns null for non-angle kinds", () => {
  assert.equal(angleFromKind("master"), null);
  assert.equal(angleFromKind("angle_999"), null);
  assert.equal(angleFromKind("angle_"), null);
  assert.equal(angleFromKind("angle_45x"), null);
});

test("emptyStatus covers exactly the pipeline steps, all pending", () => {
  const status = emptyStatus();
  assert.deepEqual(Object.keys(status).toSorted(), [...PIPELINE_STEPS].toSorted());
  assert.ok(Object.values(status).every((s) => s === "pending"));
});
