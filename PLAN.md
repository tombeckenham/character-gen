# character-gen — Plan

An agent-first character generator for the fal.ai hackathon. You sit in Claude Code and prompt; Claude drives a local CLI that generates rich characters entirely through fal APIs — character sheets, drag-to-spin turnarounds, bespoke voices — stores them locally, renders a live static gallery, and publishes finished characters to the fal platform via the Assets Characters API.

**Design thesis:** no server, no lifecycle, no UI-triggered actions. Every verb is a CLI command wrapped by a Claude Code skill. The "app" is a self-contained static HTML gallery that live-refreshes while Claude works. This mirrors (and one-ups) fal's own genmedia gallery, which is deliberately static/`file://` — ours is static _and_ live.

## Architecture

```
Claude Code (skills) ──run──▶ character-gen CLI ──▶ fal APIs (only)
                                    │
                                    ├─▶ characters/<identifier>/ (character.json + media — git-committable)
                                    └─▶ gallery/ (index.html + data.js + media)
                                              ▲
                              browser (file://) polls data.js every 2s
```

- **`packages/engine`** — TypeScript library: fal client, key resolution, the folder-backed character store (plain JSON + files, no database), pipeline steps, gallery writer. Zero native modules, nothing for the installer to compile.
- **`packages/cli`** — thin command wrapper (`character-gen …`) over the engine. Shimmed into `~/.local/bin` by the installer (same trick genmedia uses).
- **`gallery-app/`** — React + TanStack Router SPA compiled to a **single self-contained HTML file** (Vite + `vite-plugin-singlefile`; ES modules and `fetch()` are blocked on `file://`, so everything is inlined). The CLI copies the built `index.html` into the gallery dir.
- **`skills/`** — Claude Code skills (markdown) that call the CLI.
- **`install.sh`** — curl installer: clone, `pnpm install && pnpm build`, shim CLI, install skills into `~/.claude/skills`, detect fal key.

**Runtime requirement: Node ≥ 22.18 (target Node 24 LTS).** The CLI's `bin` runs `src/index.ts` directly under Node type stripping, unflagged from 22.18/23.6 and built into Node 24. The installer checks `node --version` up front and fails with an install hint; `engines` in package.json enforces it. No native modules anywhere in the dependency tree (no node-gyp) — the biggest `curl | sh` failure mode is designed out. Stretch: `bun build --compile` standalone binary (the same trick genmedia ships with) for a zero-prerequisite install.

### The live static gallery (no server)

Browsers block `fetch()` on `file://` pages, but `<script src>` tags load relative local files fine. So character data ships as `data.js` (`window.CHARGEN_DATA = {version, characters: [...]}`), and the page polls by re-injecting `<script src="data.js?t=<now>">` every 2s; when `version` changes it re-renders in place — no reload flicker, scroll preserved. Images/audio/GLB load via relative paths. The CLI rewrites `data.js` after every pipeline step, so characters materialize on screen while Claude works.

The gallery is a **pure viewer**. All actions happen in Claude Code.

### Key resolution (in order)

1. `FAL_KEY` env var
2. `~/.genmedia/config.json` → `apiKey` (reuse the genmedia CLI's key)
3. `character-gen setup` — prompts and stores in `~/.character-gen/config.json`

`character-gen doctor` reports which source is active and pings fal.

## Character pipeline

Each step records fal `request_id`s in the character's `character.json` — they double as `reference_images` for publishing (fal prefers request IDs over URLs for fal-generated media).

1. **Profile** — structured JSON: name, identifier (slug), archetype, personality, backstory, visual canon (locked physical description used in every image prompt), voice description. **Claude writes this** in the skill flow (it's the LLM in the room). `--profile-json` lets skills pass the full profile; a `--surprise` mode has the skill roll archetype × era × quirk × flaw first so demo characters are weird and delightful.
2. **Character sheet** — `openai/gpt-image-2`: master reference image from the visual canon. `openai/gpt-image-2/edit`: expression sheet + outfit variants derived from the master, keeping identity consistent.
3. **Turnaround** — `fal-ai/qwen-image-edit-2511-multiple-angles`: 8 views at 45° from the master image. Gallery renders a drag-to-scrub pseudo-3D spinner (preloaded frames; drag or scroll to rotate). Stretch: real mesh via `fal-ai/hyper3d/rodin` (v2.5) + `<model-viewer>` GLB orbit.
4. **Voice** — `fal-ai/minimax/voice-design`: turns the voice description into a signature voice sample, stored per character. `bytedance/seed-audio-1.0`: speaks any line using that sample as `@Audio1` reference audio. Every character's voice is derived from who they are.
5. **Publish** — fal Assets Characters API (see below).

## fal Assets Characters integration (must-have)

Docs: https://fal.ai/docs/platform-apis/v1/assets/characters/create

**Publish shells out to the genmedia CLI** — it already wraps the full Assets Characters CRUD surface (`genmedia assets characters list|create|get|update|delete|favorite|unfavorite`), so we do not hand-roll the HTTP calls. `character-gen publish` requires `genmedia` on PATH and fails with an install hint when it's missing.

- Create: `genmedia assets characters create "<name>" --description "<distilled>" --identifier <slug> --reference_image <ids> --cover_image_url <url> --idempotency_key <key> --json`
- `description` is **required** (≤2000, used for semantic matching) — distilled from the profile: archetype + personality + visual canon.
- `--reference_image` takes fal **request_ids** directly (1–20 max); publish-priority picks the top 20 across master, faces, expressions, details, and turnaround frames.
- `identifier` (@mention handle) ≤64; `cover_image_url` must be fal-hosted — we pass the master image's fal URL.
- `--idempotency_key` derived from the local character UUID so retries are safe.
- The returned `character.id` is stored in `character.json` as `falCharacterId`; when present, publish runs `genmedia assets characters update <id> …` instead (PATCH semantics — a passed `--reference_image` set replaces the whole list).

## CLI surface

```
character-gen create "<description>" [--profile-json <file>] [--surprise] [--steps profile,sheet,turnaround,voice]
character-gen list / show <id|identifier>
character-gen sheet <char>            # (re)generate master + expressions
character-gen turnaround <char>       # 8-angle spin frames
character-gen voice <char>            # design signature voice
character-gen speak <char> "<line>"   # TTS with the character's voice
character-gen extract <script-file>   # emits cast JSON for the skill to iterate
character-gen publish <char>          # create/update on fal Assets
character-gen open                    # write gallery + open file:// URL in browser
character-gen setup / doctor
```

`extract` parses the script to text; **Claude does the actual cast extraction** in the skill (reads the file, writes profile JSONs, loops `create --profile-json`).

## Skills (`~/.claude/skills`)

| Skill                  | What it does                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `character-gen`        | Bootstrap/meta skill: runs installer if CLI missing, teaches Claude the CLI surface |
| `create-character`     | Invent profile (or surprise-roll), run full pipeline, open gallery                  |
| `extract-characters`   | Read a script/screenplay, extract the cast, batch-generate everyone                 |
| `character-voice`      | Design a voice / make a character speak a line                                      |
| `character-turnaround` | Generate/refresh the 8-angle spin                                                   |
| `publish-character`    | Push to fal Assets Characters, report the fal character id                          |

## Data model (folders + JSON)

No database. Each character is a self-contained, git-committable folder in the project directory:

```
characters/
  <identifier>/
    character.json           # id (uuid), name, profile, per-step status, falCharacterId, assets[]
    master.png, joy.png, …   # downloaded media, referenced by relative path
gallery/                     # derived viewer output (index.html + data.js + copied media)
```

- `character.json` embeds the asset records (kind: master|expression|outfit|face_*|detail|scale|angle_0..330|voice_sample|speech, fal_request_id, url, relative local path, meta) — request_ids double as publish `reference_images`.
- Every JSON write goes through temp-file + rename, so a killed process never leaves a torn file.
- Identifier uniqueness is the directory name. `characters/` and `gallery/` live in the cwd by default; setting `CHARACTER_GEN_HOME` relocates everything (tests, or an intentionally global library).
- The API key stays global in `~/.character-gen/config.json` — never inside the committable folders.
- The gallery `data.js` version is a content hash of the payload, so the polling page re-renders exactly when content changes.

## Build order (demo-risk first)

1. Monorepo scaffold, engine (key resolution, fal client, character store), CLI skeleton, `doctor`
2. Profile + sheet generation end-to-end (`create` → gpt-image-2 → character folder)
3. Gallery: single-file build, data.js writer, live polling, character cards + detail
4. Skills: `character-gen` + `create-character` — the live-demo moment
5. Turnaround + drag-to-spin viewer
6. Voice design + `speak`
7. **Publish to fal Assets Characters**
8. `extract` + `extract-characters` skill
9. `install.sh`, surprise-me polish, README, demo script

Every endpoint schema gets verified with `genmedia schema <endpoint>` before implementation — fal's catalog moves fast.

## Demo script (3 min)

1. `character-gen open` — empty gallery on screen
2. Ask Claude: _"create a surprise character"_ → profile appears, sheet fills in live, turnaround spins, voice says a line in-character
3. Ask Claude: _"here's a script, generate the cast"_ → gallery fills with the ensemble
4. Ask Claude: _"publish the lighthouse keeper to fal"_ → show the character on fal Assets
5. Close: "No server. One CLI. Five skills. 100% fal."
