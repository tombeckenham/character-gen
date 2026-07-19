---
name: character-gen
description: Bootstrap and reference skill for the character-gen CLI — an agent-first character generator built on fal.ai. Use it to learn the CLI surface, set up the fal API key, troubleshoot with doctor, and decide which command fits a task. Other character-gen skills (create-character, character-turnaround) assume this knowledge.
---

# character-gen — CLI reference

character-gen generates rich characters entirely through fal APIs — character sheets, 12-angle turnarounds, voices — stores them locally, and renders a live static gallery. Every verb is a CLI command; you (Claude) are the brain that authors profiles and drives the pipeline. The gallery is a pure viewer: never try to trigger actions from it.

## Running the CLI

If `character-gen` is not on PATH, run it from the repo checkout:

```sh
node packages/cli/src/index.ts <command> [args]
```

(Requires Node >= 22.13. From anywhere else, use the absolute path to `packages/cli/src/index.ts`.)

## Command surface

| Command                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character-gen create "<description>" [--profile-json <file>] [--steps <list>] [--tier core\|rich\|full]` | Create a character and run pipeline steps. Steps available now: profile, sheet, turnaround — all three by default (the 12-frame spin adds 12 generations; skip it with `--steps profile,sheet`). `--tier` adds rich-sheet passes after the core sheet: rich = face triptych + named expressions + 2 detail macros (12 sheet generations), full = rich + scale + up to 4 details (15). |
| `character-gen list`                                                                                      | List all stored characters with a done-step count (e.g. 2/5) and publish state.                                                                                                                                                                                                                                                                                                       |
| `character-gen show <id\|identifier>`                                                                     | Print a character's full profile JSON and assets (including fal request ids).                                                                                                                                                                                                                                                                                                         |
| `character-gen sheet <char> [--tier core\|rich\|full] [--passes <list>]`                                  | (Re)generate the master reference image + expression/outfit variants. `--tier` also runs that tier's extra passes; `--passes face,expressions,details,scale` reruns just those passes off the existing master (the two flags are mutually exclusive).                                                                                                                                 |
| `character-gen turnaround <char>`                                                                         | Generate the 12-angle spin frames from the master (requires a completed sheet).                                                                                                                                                                                                                                                                                                       |
| `character-gen open [--no-browser]`                                                                       | Write the gallery and open its `file://` URL. The page live-refreshes every 2s while other commands run.                                                                                                                                                                                                                                                                              |
| `character-gen setup [--api-key <key>]`                                                                   | Validate and store a fal API key.                                                                                                                                                                                                                                                                                                                                                     |
| `character-gen doctor`                                                                                    | Diagnose Node version, key source, fal connectivity, and DB health.                                                                                                                                                                                                                                                                                                                   |

Coming soon (recognized but not implemented yet — do not run them): voice, speak, publish, extract.

Every command supports `--help`.

If a command exits non-zero, report the failure to the user; do not continue to the next step.

## Which command when

- New character → the **create-character** skill (authors a rich profile, then `character-gen create --profile-json`).
- Character exists but images are missing/bad → `character-gen sheet <identifier>` regenerates them.
- Add or refresh the 3D-style spin → the **character-turnaround** skill (`character-gen turnaround <identifier>`).
- User wants to see results → `character-gen open`, ideally BEFORE generating so they watch it fill in live.
- Anything erroring → `character-gen doctor` first.

Rule of thumb for every character-touching flow: open the gallery (`character-gen open`) before or right after the first generation command, and end your report with the character's deep link — `file://<gallery dir>/index.html#/c/<identifier>` (the gallery dir is printed by `open`). The user should never have to ask where to look.

## API key resolution (in order)

1. `FAL_KEY` environment variable
2. `~/.genmedia/config.json` → `apiKey` (reuses the genmedia CLI's key)
3. `~/.character-gen/config.json` — written by `character-gen setup`

## State locations

- `~/.character-gen/db.sqlite` — characters, per-step status, assets (with fal request ids)
- `~/.character-gen/media/<identifier>/` — downloaded images/audio
- `~/.character-gen/gallery/` — `index.html` + `data.js` + copied media; open via `file://`
- `~/.character-gen/config.json` — stored API key (mode 0600)

## Troubleshooting with doctor

Run `character-gen doctor` whenever a command fails. It reports:

- **node**: needs >= 22.13 (the built-in `node:sqlite` driver).
- **key**: which source resolved. "none found" → run `character-gen setup` or export `FAL_KEY`.
- **fal ping**: a 401 with the key coming from genmedia usually means genmedia stored the key **encrypted** on that machine — the raw value is unusable. Fix: `character-gen setup` with a real key from fal.ai.
- **db**: SQLite health under `~/.character-gen`.

Common failures:

- "No fal API key found" → `character-gen setup`, or export `FAL_KEY`.
- "No master image found … run `character-gen sheet` first" → the turnaround needs a completed sheet; run `character-gen sheet <identifier>`, then retry.
- "gallery not built" → the gallery SPA was never built in this checkout; run `bun run build:gallery` in the repo, then `character-gen open`.
