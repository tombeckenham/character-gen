# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Agent-first character generator for the fal.ai hackathon. Claude Code skills drive a local `character-gen` CLI that generates characters entirely through fal APIs (character sheets, 12-angle turnarounds, bespoke voices), stores them locally, and publishes to the fal Assets Characters API. **PLAN.md is the full spec** — read it before implementing any pipeline step. Note: PLAN.md predates the switch to bun and still mentions pnpm; bun wins.

Design thesis: no server, no UI-triggered actions. Every verb is a CLI command wrapped by a Claude Code skill. The gallery is a pure viewer — a single self-contained static HTML file opened via `file://` that live-refreshes while the CLI works.

## Tooling rules

- **Bun** is the package manager and script runner. Install dependencies with `bun add <pkg>` (`-d` for dev, `--cwd packages/<name>` or cd into the workspace for package-level deps) — **never add dependencies by hand-editing package.json**; `bun add` always resolves the latest version.
- **TypeScript 7** (native compiler) with a very strict root `tsconfig.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, etc.). Fix errors properly; don't loosen compiler options. `erasableSyntaxOnly` is on because the CLI's `bin` runs `src/index.ts` directly under Node type stripping — no `enum`, `namespace`, or constructor parameter properties anywhere.
- **oxfmt** for formatting, **oxlint** for linting (configs: `.oxfmtrc.json`, `.oxlintrc.json`). No prettier/eslint/biome.
- **lefthook** runs typecheck + lint + format on pre-commit (`lefthook.yml`); format auto-fixes and re-stages. After a fresh clone run `bunx lefthook install`.
- **TanStack**: use the `tanstack` skill / `@tanstack/cli` to look up TanStack docs, and after installing a TanStack library use `@tanstack/intent` to install its skills.
- **Runtime target is Node ≥ 22.18** (bun is for dev; the shipped CLI runs `src/index.ts` on the user's Node via type stripping, unflagged from 22.18). No database — state is plain JSON + files (see below). Never introduce native modules (no node-gyp anywhere in the tree) — a clean `curl | sh` install is a core requirement.
- Verify every fal endpoint schema with `genmedia schema <endpoint>` before implementing against it.

## Commands

```sh
bun install               # install all workspace deps
bun run typecheck         # tsc --noEmit across all workspaces
bun run lint              # oxlint .
bun run format            # oxfmt . (writes)
bun run format:check      # oxfmt --check .
bun run check             # typecheck + lint + format:check
```

Tests run via `bun run test` (node --test over packages/_/src/\**/_.test.ts).

## Architecture

Bun workspaces monorepo:

- `packages/engine` — the library: fal client, API-key resolution, the folder-backed character store (`src/store/`), pipeline steps, gallery writer. All real logic lives here.
- `packages/cli` — thin `character-gen` command wrapper over the engine (`bin` → `src/index.ts`).
- `gallery-app/` — React + TanStack Router SPA compiled to a **single self-contained HTML file** (Vite + vite-plugin-singlefile); `fetch()` and ES modules are blocked on `file://`, so everything must be inlined.
- `skills/` — Claude Code skills (markdown) that call the CLI.

Data flow: skills → CLI → fal APIs only. Characters are **project-local and git-committable**: one `characters/<identifier>/` folder per character in the cwd, holding `character.json` (profile, per-step status, embedded asset records with relative media paths) plus the downloaded media. Only the API key lives globally in `~/.character-gen/config.json`; `CHARACTER_GEN_HOME` relocates everything under one dir (tests rely on this). The CLI writes `gallery/` in the cwd (index.html + data.js + media); the gallery page polls by re-injecting `<script src="data.js?t=...">` every 2s and re-renders in place when the `version` field (a content hash) changes — that's the live-refresh trick, since `fetch()` doesn't work on `file://`.

Character pipeline (each step records fal `request_id`s in the character's character.json; they double as `reference_images` for publish):

1. **Profile** — Claude authors the JSON (name, identifier, archetype, visual canon, voice description) in the skill flow and passes `--profile-json`.
2. **Sheet** — `openai/gpt-image-2` master image; `/edit` for expressions/outfits keeping identity.
3. **Turnaround** — `fal-ai/qwen-image-edit-2511-multiple-angles`, 12 views at 30°; gallery renders drag-to-scrub spinner.
4. **Voice** — `fal-ai/minimax/voice-design` signature sample; `bytedance/seed-audio-1.0` speaks lines with it.
5. **Publish** — shell out to `genmedia assets characters create/update` (request_ids as `reference_images`, max 20; `--idempotency_key` derived from local UUID). Store the returned fal character id in character.json; publish becomes update when it exists.

fal API key resolution order: `FAL_KEY` env → `~/.genmedia/config.json` `apiKey` → `~/.character-gen/config.json` (written by `character-gen setup`).
