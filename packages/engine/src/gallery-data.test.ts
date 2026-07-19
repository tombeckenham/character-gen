import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGalleryData, reduceGalleryPoll } from "./gallery-data.ts";
import type { GalleryData } from "./gallery-data.ts";

function payload(version: number): GalleryData {
  return {
    version,
    characters: [
      {
        identifier: "isolde-keeper",
        name: "Isolde",
        archetype: "lighthouse keeper",
        status: {
          profile: "done",
          sheet: "running",
          turnaround: "pending",
          voice: "pending",
          publish: "pending",
        },
        assets: [{ kind: "master", path: "media/isolde-keeper/master-1.png" }],
      },
    ],
  };
}

test("parseGalleryData accepts a writer-shaped payload", () => {
  const parsed = parseGalleryData(payload(3));
  assert.ok(parsed);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.characters.length, 1);
  const character = parsed.characters[0];
  assert.ok(character);
  assert.equal(character.identifier, "isolde-keeper");
  assert.equal(character.archetype, "lighthouse keeper");
  assert.equal(character.status.sheet, "running");
  assert.deepEqual(character.assets, [
    { kind: "master", path: "media/isolde-keeper/master-1.png" },
  ]);
});

test("parseGalleryData rejects unusable top-level shapes", () => {
  // window.CHARGEN_DATA is undefined before data.js ever loads.
  // oxlint-disable-next-line no-useless-undefined
  assert.equal(parseGalleryData(undefined), null);
  assert.equal(parseGalleryData(null), null);
  assert.equal(parseGalleryData("nope"), null);
  assert.equal(parseGalleryData({}), null);
  assert.equal(parseGalleryData({ version: "1", characters: [] }), null);
  assert.equal(parseGalleryData({ version: Number.NaN, characters: [] }), null);
  assert.equal(parseGalleryData({ version: 1 }), null);
});

test("parseGalleryData drops malformed characters and assets, keeps the rest", () => {
  const parsed = parseGalleryData({
    version: 1,
    characters: [
      { identifier: "", name: "Nameless" },
      {
        identifier: "ok",
        name: "Okay",
        status: { sheet: "bogus" },
        assets: [
          { kind: "master", path: "" },
          { kind: "master" },
          "junk",
          { kind: "expression", path: "media/ok/expression-1.png" },
        ],
      },
      "junk",
    ],
  });
  assert.ok(parsed);
  assert.equal(parsed.characters.length, 1);
  const character = parsed.characters[0];
  assert.ok(character);
  assert.equal(character.identifier, "ok");
  // Unknown status values normalize to pending; missing steps default too.
  assert.equal(character.status.sheet, "pending");
  assert.equal(character.status.profile, "pending");
  assert.deepEqual(character.assets, [{ kind: "expression", path: "media/ok/expression-1.png" }]);
});

test("reduceGalleryPoll renders the first valid payload", () => {
  const outcome = reduceGalleryPoll(null, payload(1));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.data?.version, 1);
});

test("reduceGalleryPoll keeps object identity when the version is unchanged", () => {
  const current = payload(2);
  const outcome = reduceGalleryPoll(current, payload(2));
  assert.equal(outcome.changed, false);
  // Same object, so a React state set with it bails out of re-rendering.
  assert.equal(outcome.data, current);
});

test("reduceGalleryPoll re-renders on a version change", () => {
  const outcome = reduceGalleryPoll(payload(2), payload(3));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.data?.version, 3);
});

test("reduceGalleryPoll keeps current data when the payload is unusable (mid-write)", () => {
  const current = payload(5);
  for (const raw of [undefined, null, "torn", {}]) {
    const outcome = reduceGalleryPoll(current, raw);
    assert.equal(outcome.changed, false);
    assert.equal(outcome.data, current);
  }
});
