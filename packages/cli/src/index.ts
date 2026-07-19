#!/usr/bin/env node
// Install the SQLite warning filter BEFORE anything pulls in node:sqlite, then
// load the CLI dynamically so node:sqlite is linked after the filter is in place
// (a static import would link it — and emit the warning — too early).
import { installSqliteWarningFilter } from "./quiet.ts";

installSqliteWarningFilter();

const { run } = await import("./run.ts");
process.exitCode = await run(process.argv.slice(2));
