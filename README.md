# character-gen

Agent-first character generator for the fal.ai hackathon. You sit in Claude Code and prompt; Claude drives a local `character-gen` CLI that generates rich characters entirely through fal APIs — character sheets, 12-angle drag-to-spin turnarounds, bespoke voices — stores each character as a **git-committable folder**, renders a live static gallery, and publishes finished characters to the fal Assets Characters API.

**Design thesis:** no server, no UI-triggered actions. Every verb is a CLI command wrapped by a Claude Code skill. The gallery is a pure viewer — one self-contained static HTML file opened via `file://` that live-refreshes while the CLI works.

## Install

### 1. Add the Claude Code plugin

In Claude Code, register this repo as a plugin marketplace and install the plugin:

```
/plugin marketplace add tombeckenham/character-gen
/plugin install character-gen@character-gen
```

That gives you the **cast** skill and `/cast` command — the agent surface that authors profiles and drives the pipeline.

### 2. Install the CLI it drives

The skill runs a local `character-gen` CLI. Install it onto your PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/tombeckenham/character-gen/main/install.sh | sh
```

Requirements: git, Node ≥ 22.18 (the CLI runs TypeScript directly via type stripping — zero native modules, nothing to compile), and [bun](https://bun.sh) for the install/build. Publishing additionally needs the `genmedia` CLI on PATH.

Then either export `FAL_KEY`, reuse an existing `~/.genmedia/config.json`, or run `character-gen setup`.

> The curl installer also drops the **cast** skill into `~/.claude/skills`, so it works standalone without the plugin — but the plugin is the tidiest way to keep the skill and `/cast` command up to date.

## Use it from Claude Code

Once the plugin (or installer) has added the **cast** skill, just ask:

> create a surprise character — something weird

Claude interviews you (or surprise-rolls), authors a rich profile, runs the pipeline, and hands you a live gallery link that fills in while images generate.

## CLI surface

```
character-gen create "<description>" [--profile-json <file>] [--steps <list>] [--tier core|rich|full]
character-gen list / show <id|identifier>
character-gen sheet <char> [--tier ...] [--passes ...]   # master + expressions/outfit (+ rich passes)
character-gen turnaround <char>                          # 12-angle spin frames at 30°
character-gen voice <char>                               # design the signature voice
character-gen speak <char> "<line>" [--emotion <e>]      # TTS in that voice
character-gen publish <char>                             # create/update on fal Assets (via genmedia)
character-gen extract <script-file>                      # print a script for cast extraction
character-gen open                                       # write gallery + open file:// URL
character-gen setup / doctor
```

## Data model: folders, not a database

Each character is a self-contained folder in your project directory — commit it to git and it works on any machine:

```
characters/
  isolde-keeper/
    character.json        # profile, per-step status, fal ids, asset records (relative paths)
    master-1.png, …       # generated media
gallery/                  # derived viewer output (index.html + data.js + media)
```

Only the API key lives globally (`~/.character-gen/config.json`). `CHARACTER_GEN_HOME` relocates everything for tests or a deliberately global library.

## The live static gallery

Browsers block `fetch()` on `file://`, but `<script src>` works — so the gallery polls by re-injecting `data.js` every 2 s and re-renders when its content-hash version changes. Characters materialize on screen while Claude works: sheet, spin frames arriving one by one, voice, publish state.

## Development

```sh
bun install
bun run check        # typecheck + lint + format:check
bun run test         # node --test across all workspaces
bun run build:gallery
```

See `PLAN.md` for the full spec and `CLAUDE.md` for contributor conventions.
