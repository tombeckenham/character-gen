#!/usr/bin/env node
import { loadDotEnvFiles } from "./load-env.ts";
import { run } from "./run.ts";

// Pick up FAL_KEY (etc.) from a cwd .env.local/.env before anything reads
// process.env — a real env var still wins. See loadDotEnvFiles for precedence.
loadDotEnvFiles();

process.exitCode = await run(process.argv.slice(2));
