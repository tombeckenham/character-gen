---
name: character-turnaround
description: Generate or refresh the 8-angle turnaround (drag-to-scrub 360° spin) for an existing character via the character-gen CLI. Use when the user asks for a turnaround, spin, rotation, or "see them from all sides".
---

# character-turnaround

Generates 8 views of an existing character at 45° increments (0° front → 315°), shot from the master reference image so every frame is the same person. The gallery detail page renders them as a drag-to-scrub pseudo-3D spinner. (CLI basics and troubleshooting: see the **character-gen** skill. If `character-gen` is not on PATH, run it from the repo checkout as `node packages/cli/src/index.ts <command>`.)

## Flow

1. Identify the character. If unsure of the identifier: `character-gen list`.
2. Check readiness: the turnaround needs a completed sheet (a master image). `character-gen show <identifier>` — look for a `master` asset. If missing, run `character-gen sheet <identifier>` first.
3. Open the gallery so the user watches frames arrive one by one (each of the 8 frames appears live as it lands):

   ```sh
   character-gen open
   ```

4. Generate:

   ```sh
   character-gen turnaround <identifier>
   ```

   This is 8 image generations run sequentially — expect a few minutes. Progress streams per angle.

5. Report: point the user at the character's detail page in the gallery — **drag horizontally or scroll on the turnaround image to spin the character**. Say how many of the 8 frames landed; a failure stops the run at that angle, so if it stopped early, report where. ALWAYS end the report with the character's deep link (`file://<gallery dir>/index.html#/c/<identifier>` — the gallery path is printed by `character-gen open`), so the spin is one click away.

## Notes

If a command exits non-zero, report the failure to the user; do not continue to the next step.

- Re-running `character-gen turnaround` on the same character regenerates all 8 frames (e.g. after a new sheet); the spinner always shows the newest frame per angle.
- "No master image found" → run `character-gen sheet <identifier>` first, then retry.
- Key/connectivity errors → `character-gen doctor`.
