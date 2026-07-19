---
name: create-character
description: Invent a rich character profile (or roll a surprise one), generate it through the character-gen CLI pipeline (sheet, optional turnaround), and watch it appear live in the gallery. Use when the user asks to create, invent, or "surprise me with" a character.
---

# create-character

You author the character — the CLI only generates media. The quality of every image and voice downstream depends on the profile you write here, so write it with care before touching the CLI. (CLI basics, key setup, troubleshooting: see the **character-gen** skill. If `character-gen` is not on PATH, run it from the repo checkout as `node packages/cli/src/index.ts <command>`.)

## Flow

### 1. Author a rich CharacterProfile JSON

```json
{
  "name": "Isolde Marrow",
  "identifier": "isolde-marrow",
  "archetype": "lighthouse keeper",
  "personality": "stoic, dry-witted, secretly sentimental",
  "backstory": "Thirty years tending a light nobody sails past anymore…",
  "visualCanon": "weathered woman in her 60s, silver braid over the left shoulder, oilskin coat the color of storm water, brass spyglass on a neck chain, pale scar through the right eyebrow",
  "voiceDescription": "low, gravelly alto; unhurried; faint coastal lilt; sounds like she is always half-smiling"
}
```

Rules:

- `identifier`: lowercase slug — letters, digits, hyphens only, max 64 chars (e.g. `isolde-marrow`). Must be unique; suffix `-2` if taken.
- `visualCanon` is the **locked physical description** reused verbatim in every image prompt — it is what keeps the sheet, expressions, and all 8 turnaround frames the same person. Make it concrete and specific: age, build, hair, signature garment, one or two unmistakable props or marks. Vague canon = identity drift.
- `voiceDescription` will drive voice design later; write it even though voice generation is not wired up yet.
- `personality` and `backstory` are free-form; a couple of vivid sentences each.

### 2. If the user asked for a surprise

Roll (genuinely randomly — don't just pick the first row) one entry from **each** table below, then derive the whole profile from the combination. Commit to the weirdness; the collision of era and archetype is the character.

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

Name the character to fit the era, then write the full profile (step 1) from the roll — the quirk should surface in `personality`, the flaw in `backstory`, and the era should soak the `visualCanon`.

### 3. Run the pipeline

Write the JSON to a temp file, then:

```sh
character-gen create --profile-json /tmp/<identifier>.json
```

Default steps are profile + sheet (master image, expression sheet, outfit variant — 3 generations). When the user wants the full pipeline, add the 8-frame turnaround (8 more generations):

```sh
character-gen create --profile-json /tmp/<identifier>.json --steps profile,sheet,turnaround
```

### 4. Open the gallery — ideally before/while generating

```sh
character-gen open
```

Run this early so the user watches the character materialize live: the card appears at profile, images fill in as the sheet lands, status chips pulse while steps run. The page polls every 2 seconds on its own.

### 5. Report

Tell the user: name, identifier, what was generated (with file paths from the CLI output), and what's next (e.g. `character-gen turnaround <identifier>` for the spin if they skipped it — the detail page renders it as a drag-to-scrub spinner).

## Errors

- Key errors ("No fal API key found", 401s) → run `character-gen doctor` and follow its hint; usually `character-gen setup`.
- "No master image found" on the turnaround step → the sheet must finish first: `character-gen sheet <identifier>`, then `character-gen turnaround <identifier>`.
- Identifier taken → suffix `-2` and retry.
- A failed step marks its status chip red in the gallery; re-running the same command retries it safely.
