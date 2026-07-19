import { join } from "node:path";

/**
 * Best-effort dev convenience: loads `.env.local` then `.env` from `cwd` into
 * `process.env`, mirroring what bun does automatically during development so
 * the shipped CLI (plain `node`, which does not autoload dotenv) behaves the
 * same. `process.loadEnvFile` never overrides an already-set variable, so
 * precedence is: real environment → `.env.local` → `.env`. `.env.local` is
 * loaded first precisely so its values win over `.env`.
 *
 * A missing file makes `loadEnvFile` throw; that is expected and ignored — this
 * is opportunistic, never required (the canonical key path is `character-gen
 * setup`). Errors are otherwise swallowed so a malformed `.env` can never stop
 * the CLI from starting.
 */
export function loadDotEnvFiles(cwd: string = process.cwd()): void {
  for (const name of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(join(cwd, name));
    } catch {
      // Missing or unreadable file: skip it, this is best-effort.
    }
  }
}
