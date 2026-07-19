import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonClause,
  buildNegativeClause,
  composePublishDescription,
  imperfectionPhrase,
  profileExpressions,
  profileImperfections,
  PUBLISH_DESCRIPTION_MAX,
} from "./canon.ts";
import { DEFAULT_EXPRESSIONS } from "./types.ts";
import type { CharacterProfile } from "./types.ts";

const RICH: CharacterProfile = {
  name: "Aldous Grey",
  identifier: "aldous-grey",
  archetype: "storm-chasing sea captain",
  personality: "stoic, dry-witted",
  visualCanon: "wiry man in an oilskin coat",
  voiceDescription: "low, gravelly alto",
  physical: {
    apparentAge: "late 40s",
    build: "wiry, slight stoop",
    heightCm: 178,
    eyes: "pale grey, left eye slightly narrower",
  },
  imperfections: [
    { what: "thin white scar", where: "left eyebrow to temple", story: "gaff hook winter" },
    { what: "chipped front tooth", where: "upper left" },
  ],
  signatureItems: ["brass pocket compass on a leather cord"],
  palette: ["storm grey", "oxblood"],
  materials: ["worn oilskin"],
  motion: { gait: "rolling, like the deck is still moving", habit: "thumbs the compass lid" },
  negativeCanon: ["never clean-shaven", "wears bright colors"],
};

test("buildCanonClause folds every canon field into one clause", () => {
  const clause = buildCanonClause(RICH);
  assert.match(clause, /Appearance to reproduce exactly: wiry man in an oilskin coat\./u);
  assert.match(clause, /apparent age: late 40s/u);
  assert.match(clause, /178 cm tall/u);
  assert.match(clause, /thin white scar \(left eyebrow to temple\)/u);
  assert.match(clause, /chipped front tooth \(upper left\)/u);
  assert.match(clause, /brass pocket compass/u);
  assert.match(clause, /Materials: worn oilskin\./u);
  assert.match(clause, /Color palette: storm grey, oxblood\./u);
});

test("buildCanonClause is empty for a minimal profile", () => {
  assert.equal(buildCanonClause({ name: "X", identifier: "x" }), "");
});

test("buildNegativeClause normalizes entries to 'never …' prose", () => {
  const clause = buildNegativeClause(RICH);
  assert.equal(clause, "Hard rules: never clean-shaven; never wears bright colors.");
  assert.equal(buildNegativeClause({ name: "X", identifier: "x" }), "");
});

test("profileExpressions returns named expressions, else the default four", () => {
  assert.deepEqual(
    profileExpressions({ name: "X", identifier: "x", expressions: ["dread", " bone-tired "] }),
    ["dread", "bone-tired"],
  );
  assert.deepEqual(profileExpressions({ name: "X", identifier: "x" }), [...DEFAULT_EXPRESSIONS]);
  assert.deepEqual(profileExpressions({ name: "X", identifier: "x", expressions: [" "] }), [
    ...DEFAULT_EXPRESSIONS,
  ]);
});

test("profileImperfections drops malformed entries and keeps order", () => {
  const kept = profileImperfections({
    name: "X",
    identifier: "x",
    imperfections: [
      { what: "scar", where: "brow" },
      { what: "  ", where: "cheek" },
      { what: "notch", where: "left ear" },
    ],
  });
  assert.deepEqual(
    kept.map((entry) => imperfectionPhrase(entry)),
    ["scar (brow)", "notch (left ear)"],
  );
});

test("composePublishDescription reuses the canon phrases and covers all sections", () => {
  const description = composePublishDescription(RICH);
  assert.match(description, /^Aldous Grey, storm-chasing sea captain\./u);
  assert.match(description, /Personality: stoic, dry-witted\./u);
  assert.match(description, /thin white scar \(left eyebrow to temple\)/u);
  assert.match(description, /Motion: gait: rolling, like the deck is still moving/u);
  assert.match(description, /Voice: low, gravelly alto\./u);
  assert.match(description, /Hard rules: never clean-shaven/u);
  assert.ok(description.length <= PUBLISH_DESCRIPTION_MAX);
});

test("composePublishDescription caps at the limit by dropping whole sentences", () => {
  const description = composePublishDescription({
    name: "X",
    identifier: "x",
    personality: "p".repeat(1900),
    backstory: "irrelevant",
    voiceDescription: "v".repeat(500),
  });
  assert.ok(description.length <= PUBLISH_DESCRIPTION_MAX);
  assert.match(description, /^X\. Personality: p+\.$/u);
});
