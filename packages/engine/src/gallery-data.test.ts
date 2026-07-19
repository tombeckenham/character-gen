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
  assert.equal(parseGalleryData({ version: 1 }), null);
  assert.equal(parseGalleryData({ version: "1", characters: [] }), null);
});

test("parseGalleryData accepts exactly the writer's version domain: positive integers", () => {
  assert.equal(parseGalleryData({ version: 1, characters: [] })?.version, 1);
  assert.equal(parseGalleryData({ version: 1000, characters: [] })?.version, 1000);
  for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(parseGalleryData({ version, characters: [] }), null, `version ${version}`);
  }
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
          { kind: "banana", path: "media/ok/banana.png" },
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
  // The unknown "banana" kind was dropped along with the shape violations.
  assert.deepEqual(character.assets, [{ kind: "expression", path: "media/ok/expression-1.png" }]);
});

test("reduceGalleryPoll renders the first valid payload", () => {
  const outcome = reduceGalleryPoll(null, payload(1));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.valid, true);
  assert.equal(outcome.data?.version, 1);
});

test("reduceGalleryPoll keeps object identity when the version is unchanged", () => {
  const current = payload(2);
  const outcome = reduceGalleryPoll(current, payload(2));
  assert.equal(outcome.changed, false);
  assert.equal(outcome.valid, true);
  // Same object, so a React state set with it is a no-op.
  assert.equal(outcome.data, current);
});

test("reduceGalleryPoll deliberately ignores changed content under an equal version", () => {
  // The atomic version counter makes this near-impossible in practice; if it
  // ever happens, the version is the contract — content under the same
  // version is treated as identical and NOT re-rendered.
  const current = payload(2);
  const differentContent = { ...payload(2), characters: [] };
  const outcome = reduceGalleryPoll(current, differentContent);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.data, current);
});

test("reduceGalleryPoll re-renders on a version change", () => {
  const outcome = reduceGalleryPoll(payload(2), payload(3));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.data?.version, 3);
});

test("reduceGalleryPoll re-renders on a version REGRESSION (writer counter reset)", () => {
  // A wiped state dir restarts the counter at 1; an open page must not freeze.
  const outcome = reduceGalleryPoll(payload(5), payload(1));
  assert.equal(outcome.changed, true);
  assert.equal(outcome.valid, true);
  assert.equal(outcome.data?.version, 1);
});

test("reduceGalleryPoll keeps current data when the payload is unusable (mid-write)", () => {
  const current = payload(5);
  for (const raw of [undefined, null, "torn", {}]) {
    const outcome = reduceGalleryPoll(current, raw);
    assert.equal(outcome.changed, false);
    assert.equal(outcome.valid, false);
    assert.equal(outcome.data, current);
  }
});
