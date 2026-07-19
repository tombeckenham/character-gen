---
name: cast
description: Cast characters with the character-gen CLI — an agent-first character generator built on fal.ai. Use it to create or invent characters (or "surprise me"), run the interview, generate rich character sheets and 12-angle turnarounds/spins, set up the fal API key, troubleshoot with doctor, and browse the live gallery.
---

# cast — the character-gen CLI

character-gen generates rich characters entirely through fal APIs — character sheets, 12-angle turnarounds, voices — stores them locally, and renders a live static gallery. Every verb is a CLI command; you (Claude) are the brain that authors profiles and drives the pipeline. The gallery is a pure viewer: never try to trigger actions from it.

## Running the CLI

If `character-gen` is not on PATH, run it from the repo checkout:

```sh
node packages/cli/src/index.ts <command> [args]
```

(Requires Node >= 22.18. From anywhere else, use the absolute path to `packages/cli/src/index.ts`.)

## Command surface

| Command                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character-gen create "<description>" [--profile-json <file>] [--steps <list>] [--tier core\|rich\|full]` | Create a character and run pipeline steps. Steps available now: profile, sheet, turnaround — all three by default (the 12-frame spin adds 12 generations; skip it with `--steps profile,sheet`). `--tier` adds rich-sheet passes after the core sheet: rich = face triptych + named expressions + 2 detail macros (12 sheet generations), full = rich + scale + up to 4 details (15). |
| `character-gen list`                                                                                      | List all stored characters with a done-step count (e.g. 2/5) and publish state.                                                                                                                                                                                                                                                                                                       |
| `character-gen show <id\|identifier>`                                                                     | Print a character's full profile JSON and assets (including fal request ids).                                                                                                                                                                                                                                                                                                         |
| `character-gen sheet <char> [--tier core\|rich\|full] [--passes <list>]`                                  | (Re)generate the master reference image + expression/outfit variants. `--tier` also runs that tier's extra passes; `--passes face,expressions,details,scale` reruns just those passes off the existing master (the two flags are mutually exclusive).                                                                                                                                 |
| `character-gen turnaround <char>`                                                                         | Generate the 12-angle spin frames from the master (requires a completed sheet).                                                                                                                                                                                                                                                                                                       |
| `character-gen voice <char>`                                                                              | Design the character's signature voice from its `voiceDescription` (a reusable custom voice + a preview clip). Run once before `speak`.                                                                                                                                                                                                                                               |
| `character-gen speak <char> "<line>" [--emotion <e>]`                                                     | Voice a line in the character's designed voice (run `voice` first). `--emotion` ∈ happy, sad, angry, fearful, disgusted, surprised, neutral. Each call adds a clip; earlier lines are kept.                                                                                                                                                                                           |
| `character-gen open [--no-browser]`                                                                       | Write the gallery and open its `file://` URL. The page live-refreshes every 2s while other commands run.                                                                                                                                                                                                                                                                              |
| `character-gen setup [--api-key <key>]`                                                                   | Validate and store a fal API key.                                                                                                                                                                                                                                                                                                                                                     |
| `character-gen doctor`                                                                                    | Diagnose Node version, key source, fal connectivity, and character-store health.                                                                                                                                                                                                                                                                                                      |

Coming soon (recognized but not implemented yet — do not run them): publish, extract.

Every command supports `--help`. If a command exits non-zero, report the failure to the user; do not continue to the next step.

Rule of thumb for every character-touching flow: open the gallery (`character-gen open`) before or right after the first generation command, and end your report with the character's deep link — `file://<gallery dir>/index.html#/c/<identifier>` (the gallery dir is printed by `open`). The user should never have to ask where to look.

## Workflow: create a character

You author the character — the CLI only generates media. The quality of every image and voice downstream depends on the profile you write, so write it with care before touching the CLI.

### 1. Interview the user — selectable questions, two batches

Run the interview through the **AskUserQuestion tool** so every question appears as a selectable prompt (the UI adds an "Other" free-text option automatically — never add your own). Batch it into exactly TWO calls (the tool caps at 4 questions per call); never ask one question at a time. Every option list ends with a **"Surprise me"** choice; a skipped or surprised answer means you invent that part from the tables in step 3. Invent fresh, evocative example options each time — the ones below are shape, not script.

**Call 1 — the character (4 questions):**

1. header `Contradiction` — "What's the gap between how they present and what they actually are?" (options like "gruff shell, soft center" / "charming liar, honest heart" / "meek clerk, apex predator" / "Surprise me")
2. header `Imperfection` — "One visible imperfection and its story?" (a scar, a chipped tooth, a mended seam — seeds `imperfections[0]` and its own macro shot)
3. header `Signature` — "What do they always carry or wear?" (seeds `signatureItems`)
4. header `Vibe`, **multiSelect** — texture/energy bundles they can combine (e.g. "weathered & deliberate" / "pristine & quick" / "soft & warm palette" / "angular & cold palette")

**Call 2 — the rules and the budget (2 questions):**

5. header `Never` — "They would never…" (seeds `negativeCanon`)
6. header `Tier` — how much to generate, costs stated plainly in the descriptions (the 12-frame turnaround runs by default on top of every tier — mention it adds 12 generations, skippable):
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
- `visualCanon` is the **locked physical description** reused verbatim in every image prompt — it is what keeps the sheet, expressions, and all 12 turnaround frames the same person. Make it concrete and specific.
- **Imperfections are identity anchors.** Models keep a chipped tooth or a mended seam consistent far more reliably than "brown hair, 60s" — give every character at least one imperfection with a story. Each one is injected into every image prompt and gets its own macro shot in the `details` pass.
- `expressions` names the character's OWN emotional range ("weathered joy", not "happy") — one image each in the rich/full tiers; defaults to joy/anger/fear/exhaustion when absent.
- `negativeCanon` is appended to every prompt as hard rules ("never …").
- `voiceDescription` drives voice design (`character-gen voice`): write it vividly — timbre, accent, pace, attitude — so the signature voice is distinctive.
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

By default this runs the whole visual pipeline: profile + sheet at the chosen tier + the 12-frame turnaround (12 generations on top of the tier — a character isn't done until you can spin them). If the user wants to skip the spin, pass the steps explicitly:

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

## Workflow: turnaround for an existing character

Generates 12 views at 30° increments (0° front → 330°), shot from the master reference image so every frame is the same person. The gallery renders them as a drag-or-flick-to-spin pseudo-3D spinner. Use when the user asks for a turnaround, spin, rotation, or "see them from all sides" on a character that already exists.

1. Identify the character (`character-gen list` if unsure of the identifier).
2. Check readiness: the turnaround needs a completed sheet. `character-gen show <identifier>` — look for a `master` asset. If missing, run `character-gen sheet <identifier>` first.
3. Open the gallery (`character-gen open`) so the user watches the 12 frames arrive one by one.
4. Generate: `character-gen turnaround <identifier>` — 12 image generations run sequentially; expect a few minutes. Progress streams per angle.
5. Report how many of the 12 frames landed (a failure stops the run at that angle — say where, if early), remind them to **drag, flick, or scroll on the turnaround image to spin**, and end with the character's deep link.

Re-running `character-gen turnaround` on the same character regenerates all 12 frames (e.g. after a new sheet); the spinner always shows the newest frame per angle.

## Workflow: give a character a voice

Turns the profile's `voiceDescription` into a real, reusable voice, then speaks lines in it. Use when the user asks to hear a character, give them a voice, or have them say something.

1. Identify the character (`character-gen list` if unsure). It needs a `voiceDescription` — `character-gen show <identifier>` to check; if it's thin, the voice is composed from archetype/personality instead, but a vivid `voiceDescription` gives a far more distinctive result.
2. Open the gallery (`character-gen open`) so the clips appear in the **Voice** section as they land.
3. Design the signature voice (once): `character-gen voice <identifier>`. Re-running redesigns it; `speak` always uses the newest.
4. Speak lines in it: `character-gen speak <identifier> "The line, in their own words."` — add `--emotion angry` (etc.) to color the delivery. Write the line in the character's diction, not neutral narration; each `speak` adds another clip so you can build a short scene.
5. Report which clips landed and end with the character's deep link. "No designed voice for …" on `speak` → run `character-gen voice <identifier>` first.

Voice can also run inside `character-gen create` via `--steps profile,sheet,voice` (it reads only the profile text, so it needs no images).

## Which command when

- New character → the create workflow above (interview → profile JSON → `character-gen create --profile-json`).
- Character exists but images are missing/bad → `character-gen sheet <identifier>` regenerates them; `--passes` reruns just the missing passes.
- Add or refresh the 3D-style spin → the turnaround workflow above.
- User wants to see results → `character-gen open`, ideally BEFORE generating so they watch it fill in live.
- Anything erroring → `character-gen doctor` first.

## API key resolution (in order)

1. `FAL_KEY` environment variable
2. `~/.genmedia/config.json` → `apiKey` (reuses the genmedia CLI's key)
3. `~/.character-gen/config.json` — written by `character-gen setup`

## State locations

Characters are project-local so they can be committed to git; run the CLI from
the project directory you want them in.

- `./characters/<identifier>/` — `character.json` (profile, per-step status, assets with fal request ids) + downloaded images/audio, one committable folder per character
- `./gallery/` — `index.html` + `data.js` + copied media; open via `file://` (derived output — gitignore it if you like)
- `~/.character-gen/config.json` — stored API key (mode 0600; never lands in the project)
- Setting `CHARACTER_GEN_HOME` relocates all of the above under one directory (tests / an intentionally global library)

## Errors and troubleshooting

Run `character-gen doctor` whenever a command fails. It reports:

- **node**: needs >= 22.18 (runs TypeScript directly via Node type stripping).
- **key**: which source resolved. "none found" → run `character-gen setup` or export `FAL_KEY`.
- **fal ping**: a 401 with the key coming from genmedia usually means genmedia stored the key **encrypted** on that machine — the raw value is unusable. Fix: `character-gen setup` with a real key from fal.ai.
- **store**: whether the `./characters/` folders read cleanly.

Common failures:

- "No fal API key found" (or 401s) → `character-gen setup`, or export `FAL_KEY`.
- "No master image found" on the turnaround step or a `--passes` run → the core sheet must finish first: `character-gen sheet <identifier>`, then retry.
- A step failed after the character was created? Do NOT re-run `character-gen create` — the identifier is now taken and you'd get "already exists". Retry just the failed piece: `character-gen sheet <identifier>` (core), `character-gen sheet <identifier> --passes face,expressions,details,scale` (whichever passes are missing — passes stop at the first failure, so a mid-run crash leaves a clean prefix), or `character-gen turnaround <identifier>`.
- "already exists" on create itself → the identifier was taken before this run; pick a new one (suffix `-2`) and retry.
- A failed step marks its status chip red in the gallery; re-running that step's command retries it safely.
- "gallery not built" → the gallery SPA was never built in this checkout; run `bun run build:gallery` in the repo, then `character-gen open`.
