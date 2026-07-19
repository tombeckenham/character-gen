# Rich character sheets — plan

Extends PLAN.md. Goal: character sheets that work as **conditioning input for image and video models** — reference pixels plus repeatable words that agree with each other — generated through an interactive creation flow, browsable with real zoom.

Design principles:

1. **Imperfections are identity anchors.** Models keep a chipped tooth, asymmetric freckles, or a mended seam consistent far more reliably than "brown hair, 40s". Every imperfection is structured data with a story, injected into every image prompt, and gets its own macro shot.
2. **Faces before outfits.** Face drift is the #1 consistency failure in downstream video. A dedicated face triptych is worth more than any outfit variant.
3. **Words and pixels must match.** Every generated reference has a textual twin in the profile; video prompts reuse the exact same phrases the images were generated from.

## 1. Profile schema extensions (`CharacterProfile`)

All new fields optional; `validateProfile` checks shape when present. Existing profiles stay valid.

```jsonc
{
  // existing: name, identifier, archetype, personality, backstory,
  //           visualCanon, voiceDescription
  "physical": {
    "apparentAge": "late 40s, looks older around the eyes",
    "build": "wiry, slight stoop",
    "heightCm": 178,
    "skin": "weathered olive, sun spots across the forearms",
    "eyes": "pale grey, left eye slightly narrower",
    "hair": "iron-grey, coarse, cropped close at the sides",
    "face": "long jaw, broken-and-reset nose, deep laugh lines",
  },
  "imperfections": [
    {
      "what": "thin white scar",
      "where": "left eyebrow to temple",
      "story": "gaff hook, the winter the boat went down",
    },
    {
      "what": "chipped front tooth",
      "where": "upper left",
      "story": "never fixed it; whistles through it when thinking",
    },
  ],
  "signatureItems": [
    "brass pocket compass on a leather cord",
    "oilskin coat, patched at the right elbow",
  ],
  "palette": ["storm grey", "oxblood", "tarnished brass"],
  "materials": ["worn oilskin", "salt-stiffened wool", "hand-mended canvas"],
  "motion": {
    "gait": "rolling, like the deck is still moving",
    "posture": "leans on doorframes, never stands square",
    "restingFace": "half-frown, eyes always tracking the horizon",
    "habit": "thumbs the compass lid open and shut",
  },
  "expressions": ["weathered joy", "cold fury", "dread", "bone-tired"],
  "negativeCanon": ["never clean-shaven", "never wears bright colors", "never hurries"],
}
```

- `expressions` names the character's own emotional range; defaults to `["joy", "anger", "fear", "exhaustion"]` when absent.
- Prompt builders concatenate `physical` + `imperfections` + `signatureItems` into every image prompt (the locked canon), and `negativeCanon` into negative guidance where the endpoint supports it, else appended as "never …" prose.
- The publish step (later phase) distills these same fields into the fal Assets `description` (≤2000 chars) for semantic matching — one composer function, tested.

## 2. New asset kinds + sheet passes

New members of `AssetKind` (string union, DB column is TEXT — no migration needed; bump `user_version` to 2 anyway to mark the era):

```
face_front | face_three_quarter | face_profile   (discrete kinds)
expression      (existing kind; named variants use meta.label)
detail          (meta.subject: "hands" | "imperfection:<n>" | "prop:<n>")
scale           (full-body neutral A-pose, height context)
```

Generation passes, all `openai/gpt-image-2/edit` from the master (identity held by reference + canon prompt):

| Pass          | Images | Contents                                              |
| ------------- | ------ | ----------------------------------------------------- |
| `face`        | 3      | neutral front close-up, 3/4, profile                  |
| `expressions` | 4      | one per named expression (profile-driven, meta.label) |
| `details`     | 2–4    | hands; one macro per imperfection/signature item      |
| `scale`       | 1      | full-body neutral, plain background                   |

Tiers (CLI + skill vocabulary):

- **core** = today's sheet (master + expression grid + outfit) — 3 generations
- **rich** = core + face + expressions + details(2) — 12 generations
- **full** = rich + scale + details(4) — 15 generations

With the 8-angle turnaround: full = 23 assets > the Assets API's 20 `reference_images` cap → publish needs a priority order: `face_* > master > scale > expression > detail > angle_0/90/180/270 > outfit > remaining angles`. Encode as a pure, tested function.

## 3. CLI surface

```
character-gen sheet <char> [--tier core|rich|full] [--passes face,expressions,details,scale]
character-gen create "<desc>" [--tier ...]        # tier implies the extra passes after the core sheet
```

- `--passes` regenerates individual passes (retry granularity mirrors sheet/turnaround).
- Each pass is a separate step _invocation_ over the shared step core (`storeAsset`, `withStepStatus`) but they all roll up into the existing `sheet` status step — per-pass progress via the reporter, per-pass gallery refresh via the turnaround's `onFrame` pattern (so rich sheets fill in live, which fixes the "sheet lands all at once" limitation honestly this time).
- Default tier stays **core** — cost stays opt-in, same reasoning as turnaround's exclusion from `DEFAULT_CREATE_STEPS`.

## 4. Interactive creation (create-character skill)

Replace the monologue with a short interview — few questions, high signal, every one skippable with "surprise me" (tables already exist):

1. **The contradiction** — "what's the gap between how they present and what they are?"
2. **One visible imperfection and its story** (seeds `imperfections[0]` and a detail macro)
3. **What do they always carry or wear?** (seeds `signatureItems`)
4. **Rapid-fire either/ors** (one line, pick any): weathered/pristine · angular/soft · loud/contained · warm/cold palette · quick/deliberate
5. **"They would never…"** (seeds `negativeCanon`)

Skill rules: ask all five in ONE message (not a 5-round trip), accept partial answers, fill gaps from the surprise tables, then show the drafted profile for a yes/tweak before spending money. Tier question asked once, with generation counts and "you can add passes later" noted.

## 5. Gallery

- **Lightbox**: click any image → fullscreen overlay; scroll/pinch zoom (accumulated-delta pattern from the spinner), drag to pan, arrow keys to move between images of the same character, Esc closes. Pure SPA, zero fal cost. Zoom math goes in the node-free contract module, unit-tested (`spinner.ts` precedent).
- **Detail page sections**: Face (triptych row), Expressions (labeled grid from meta.label), Details (macro grid with captions from meta.subject + the imperfection story as caption text), Scale. Sections render only when assets exist — same progressive pattern as the spinner.
- Card grid: face_front (when present) becomes the card image instead of cropped master.

## 6. Build order (one PR, reviewable in one pass; ~2–3 h agent time)

1. Schema + `validateProfile` + prompt builders + publish-priority pure function (tests)
2. Sheet passes in engine over the shared core + per-pass gallery refresh (tests: fake generator, pass independence, failure isolation per pass)
3. CLI `--tier`/`--passes` (tests incl. money-guard: no pass runs when a prior pass failed)
4. Lightbox + detail sections (pure zoom math tested; browser smoke for wiring)
5. Skill interview rewrite + drift-test extension for the new flags
6. Live smoke: ONE rich-tier character end-to-end (≈12 generations) + browser verification of lightbox and live pass-by-pass fill-in

## 7. Open questions for Tom

- Ordering: rich sheets next, or voice (PR5) first? (Voice is independent; rich sheets change what publish sends, so both should land before publish.)
- Default named-expression count (4 proposed) and detail-macro cap (4 proposed) — each is one generation.
- Should the interview run for `--surprise` too (rapid-fire only), or should surprise stay zero-question?
