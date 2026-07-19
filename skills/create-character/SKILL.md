---
name: create-character
description: Invent a rich character profile through a short interview (or roll a surprise one), generate it through the character-gen CLI pipeline (sheet tiers, optional turnaround), and watch it appear live in the gallery. Use when the user asks to create, invent, or "surprise me with" a character.
---

# create-character

You author the character — the CLI only generates media. The quality of every image and voice downstream depends on the profile you write here, so write it with care before touching the CLI. (CLI basics, key setup, troubleshooting: see the **character-gen** skill. If `character-gen` is not on PATH, run it from the repo checkout as `node packages/cli/src/index.ts <command>`.)

## Flow

### 1. Interview the user — selectable questions, two batches

Run the interview through the **AskUserQuestion tool** so every question appears as a selectable prompt (the UI adds an "Other" free-text option automatically — never add your own). Batch it into exactly TWO calls (the tool caps at 4 questions per call); never ask one question at a time. Every option list ends with a **"Surprise me"** choice; a skipped or surprised answer means you invent that part from the tables in step 3. Invent fresh, evocative example options each time — the ones below are shape, not script.

**Call 1 — the character (4 questions):**

1. header `Contradiction` — "What's the gap between how they present and what they actually are?" (options like "gruff shell, soft center" / "charming liar, honest heart" / "meek clerk, apex predator" / "Surprise me")
2. header `Imperfection` — "One visible imperfection and its story?" (a scar, a chipped tooth, a mended seam — seeds `imperfections[0]` and its own macro shot)
3. header `Signature` — "What do they always carry or wear?" (seeds `signatureItems`)
4. header `Vibe`, **multiSelect** — texture/energy bundles they can combine (e.g. "weathered & deliberate" / "pristine & quick" / "soft & warm palette" / "angular & cold palette")

**Call 2 — the rules and the budget (2 questions):**

5. header `Never` — "They would never…" (seeds `negativeCanon`)
6. header `Tier` — how much to generate, costs stated plainly in the descriptions (the 8-frame turnaround runs by default on top of every tier — mention it adds 8 generations, skippable):
   - `core` — master + expression grid + outfit (3 sheet generations; the safe start)
   - `rich` — core + face triptych + 4 named expressions + 2 detail macros (12 sheet generations)
   - `full` — rich + full-body scale shot + up to 4 detail macros (15 sheet generations)

Note in the tier descriptions that passes can be added later (`character-gen sheet <id> --passes …`). If the user already told you everything (or said "just make it"), skip the interview and default the tier to **core**.

### 2. Author a rich CharacterProfile JSON

```json
{
  "name": "Isolde Marrow",
  "identifier": "isolde-marrow",
  "archetype": "lighthouse keeper",
  "personality": "stoic, dry-witted, secretly sentimental",
  "backstory": "Thirty years tending a light nobody sails past anymore…",
  "visualCanon": "weathered woman in her 60s, silver braid over the left shoulder, oilskin coat the color of storm water, brass spyglass on a neck chain, pale scar through the right eyebrow",
  "voiceDescription": "low, gravelly alto; unhurried; faint coastal lilt; sounds like she is always half-smiling",
  "physical": {
    "apparentAge": "60s, looks older around the eyes",
    "build": "wiry, slight stoop",
    "heightCm": 170,
    "skin": "weathered, sun spots across the forearms",
    "eyes": "pale grey, left eye slightly narrower",
    "hair": "silver braid over the left shoulder",
    "face": "long jaw, deep laugh lines"
  },
  "imperfections": [
    {
      "what": "pale scar",
      "where": "through the right eyebrow",
      "story": "gaff hook, the winter the boat went down"
    }
  ],
  "signatureItems": ["brass spyglass on a neck chain", "oilskin coat, patched at the right elbow"],
  "palette": ["storm grey", "oxblood", "tarnished brass"],
  "materials": ["worn oilskin", "salt-stiffened wool"],
  "motion": {
    "gait": "rolling, like the deck is still moving",
    "posture": "leans on doorframes, never stands square",
    "restingFace": "half-frown, eyes tracking the horizon",
    "habit": "thumbs the spyglass lid open and shut"
  },
  "expressions": ["weathered joy", "cold fury", "dread", "bone-tired"],
  "negativeCanon": ["never hurries", "never wears bright colors"]
}
```

Rules:

- `identifier`: lowercase slug — letters, digits, hyphens only, max 64 chars (e.g. `isolde-marrow`). Must be unique; suffix `-2` if taken.
- `visualCanon` is the **locked physical description** reused verbatim in every image prompt — it is what keeps the sheet, expressions, and all 8 turnaround frames the same person. Make it concrete and specific.
- **Imperfections are identity anchors.** Models keep a chipped tooth or a mended seam consistent far more reliably than "brown hair, 60s" — give every character at least one imperfection with a story. Each one is injected into every image prompt and gets its own macro shot in the `details` pass.
- `expressions` names the character's OWN emotional range ("weathered joy", not "happy") — one image each in the rich/full tiers; defaults to joy/anger/fear/exhaustion when absent.
- `negativeCanon` is appended to every prompt as hard rules ("never …").
- `voiceDescription` will drive voice design later; write it even though voice generation is not wired up yet.
- All the structured fields are optional — a core-tier character with just `visualCanon` is still valid.

**Show the drafted profile to the user for a yes/tweak BEFORE running the CLI** — generations cost money; the profile is free to edit.

### 3. If the user asked for a surprise

A surprise skips the interview entirely — zero questions (including the tier: default **core**, unless they asked for more). Roll (genuinely randomly — don't just pick the first row) one entry from **each** table below, then derive the whole profile from the combination. Commit to the weirdness; the collision of era and archetype is the character.

| #   | Archetype                         | Era / Milieu                        | Quirk                                      | Flaw                                 |
| --- | --------------------------------- | ----------------------------------- | ------------------------------------------ | ------------------------------------ |
| 1   | lighthouse keeper                 | deep-sea Victorian brass-and-rivets | collects the last words of storms          | afraid of still water                |
| 2   | funeral clown                     | post-glacial ice-age thaw           | tips their hat to every crow               | laughs at exactly the wrong moment   |
| 3   | ghost negotiator                  | 1970s Tokyo jazz-kissa scene        | keeps receipts for debts owed by the dead  | cannot enter a room first            |
| 4   | mushroom sommelier                | Carboniferous swamp-forest          | names every spore cloud before inhaling    | trusts anything that glows           |
| 5   | tax auditor for wizards           | crumbling Ottoman clockpunk         | alphabetizes curses                        | allergic to their own magic          |
| 6   | retired kaiju wrangler            | 1950s atomic-diner Americana        | feeds parking meters "for the little ones" | heart grows audibly when lying       |
| 7   | librarian of forbidden lullabies  | drowned Venice, gondola-skyscrapers | hums in a dead language when nervous       | falls asleep at the word "hush"      |
| 8   | lightning farmer                  | Andean cloud-city terraces          | braids forecasts into their hair           | jealous of the moon                  |
| 9   | door-to-door prophet              | brutalist Soviet moon colony        | rings doorbells twice, never thrice        | prophecies only work for strangers   |
| 10  | velvet-gloved safecracker         | Belle Époque airship salons         | apologizes to every lock                   | compulsively returns what they steal |
| 11  | plague doctor turned perfumer     | neon-lit Song-dynasty night market  | rates everyone by their scent, aloud       | cannot smell their own lies          |
| 12  | cartographer of places that moved | Sahara-become-sea far future        | draws maps only from memory, blindfolded   | gets lost in straight corridors      |

Name the character to fit the era, then write the full profile (step 2) from the roll — the quirk should surface in `personality`, the flaw in `backstory`, the era should soak the `visualCanon`, and invent one imperfection-with-story that the flaw or quirk would plausibly have left on their body. These same tables fill any interview question the user skipped.

### 4. Run the pipeline

Write the JSON to a temp file, then:

```sh
character-gen create --profile-json /tmp/<identifier>.json --tier rich
```

By default this runs the whole visual pipeline: profile + sheet at the chosen tier + the 8-frame turnaround (8 generations on top of the tier — a character isn't done until you can spin them). If the user wants to skip the spin, pass the steps explicitly:

```sh
character-gen create --profile-json /tmp/<identifier>.json --tier rich --steps profile,sheet
```

### 5. Open the gallery — ALWAYS, before generating

```sh
character-gen open
```

This step is not optional: run it BEFORE the create command (or immediately after kicking it off) so the user watches the character materialize — the card appears the moment the character is created, and rich-tier passes fill the detail page in live: faces, then named expressions, then detail macros, shot by shot. A turnaround fills in frame by frame. The page polls every 2 seconds on its own; any image can be clicked for a fullscreen zoomable view. If opening a browser window would be disruptive, use `character-gen open --no-browser` and give the user the printed `file://` URL instead — one of the two, every time.

### 6. Report — always end with the gallery link

Tell the user: name, identifier, tier, what was generated (with file paths from the CLI output), and what's next — e.g. `character-gen sheet <identifier> --passes scale` to add a pass they skipped, or `character-gen turnaround <identifier>` for the spin (the detail page renders it as a drag-to-scrub spinner). ALWAYS end the report with the character's deep link so it's one click away:

```
file://<gallery path from the open command>/index.html#/c/<identifier>
```

## Errors

If a command exits non-zero, report the failure to the user; do not continue to the next step.

- Key errors ("No fal API key found", 401s) → run `character-gen doctor` and follow its hint; usually `character-gen setup`.
- "No master image found" on the turnaround step or a `--passes` run → the core sheet must finish first: `character-gen sheet <identifier>`, then retry.
- A step failed after the character was created? Do NOT re-run `character-gen create` — the identifier is now taken and you'd get "already exists". Retry just the failed piece: `character-gen sheet <identifier>` (core), `character-gen sheet <identifier> --passes face,expressions,details,scale` (whichever passes are missing — passes stop at the first failure, so a mid-run crash leaves a clean prefix), or `character-gen turnaround <identifier>`.
- "already exists" on create itself → the identifier was taken before this run; pick a new one (suffix `-2`) and retry.
- A failed step marks its status chip red in the gallery; re-running that step's command retries it safely.
