import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdOpen, openerCommand } from "./open.ts";
import type { OpenDeps } from "./open.ts";

interface SpawnCall {
  command: string;
  args: string[];
}

/** In-process harness: isolated state home, fake built SPA, recording spawner. */
function setup(): {
  dir: string;
  deps: OpenDeps & { spawner: NonNullable<OpenDeps["spawner"]> };
  calls: SpawnCall[];
} {
  const dir = mkdtempSync(join(tmpdir(), "chargen-open-"));
  const spaHtmlPath = join(dir, "spa-index.html");
  writeFileSync(spaHtmlPath, "<!doctype html><title>spa</title>");
  const calls: SpawnCall[] = [];
  const deps = {
    env: { CHARACTER_GEN_HOME: dir } as NodeJS.ProcessEnv,
    spawner: (command: string, args: string[]) => calls.push({ command, args }),
    platform: "darwin",
    spaHtmlPath,
  };
  return { dir, deps, calls };
}

test("open --no-browser writes the gallery and never spawns an opener", async () => {
  const { dir, deps, calls } = setup();
  try {
    const code = await cmdOpen(["--no-browser"], deps);
    assert.equal(code, 0);
    const galleryDir = join(dir, "gallery");
    assert.ok(existsSync(join(galleryDir, "index.html")));
    const dataJs = readFileSync(join(galleryDir, "data.js"), "utf8");
    assert.match(dataJs, /^window\.CHARGEN_DATA = \{/u);
    assert.deepEqual(calls, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open spawns the platform opener with the gallery's file:// URL", async () => {
  const { dir, deps, calls } = setup();
  try {
    const code = await cmdOpen([], deps);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.command, "open");
    const url = call.args[0];
    assert.ok(url);
    assert.ok(url.startsWith("file://"), url);
    assert.ok(url.endsWith("/gallery/index.html"), url);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open uses xdg-open on linux", async () => {
  const { dir, deps, calls } = setup();
  try {
    const code = await cmdOpen([], { ...deps, platform: "linux" });
    assert.equal(code, 0);
    assert.equal(calls[0]?.command, "xdg-open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open fails cleanly when the SPA was never built", async () => {
  const { dir, deps, calls } = setup();
  try {
    const code = await cmdOpen(["--no-browser"], {
      ...deps,
      spaHtmlPath: join(dir, "missing-dist.html"),
    });
    assert.equal(code, 1);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(dir, "gallery", "index.html")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open --help exits 0", async () => {
  const code = await cmdOpen(["--help"]);
  assert.equal(code, 0);
});

test("openerCommand maps platforms to their opener", () => {
  assert.deepEqual(openerCommand("darwin", "u"), { command: "open", args: ["u"] });
  assert.deepEqual(openerCommand("linux", "u"), { command: "xdg-open", args: ["u"] });
  assert.deepEqual(openerCommand("freebsd", "u"), { command: "xdg-open", args: ["u"] });
  assert.deepEqual(openerCommand("win32", "u"), {
    command: "cmd",
    args: ["/c", "start", "", "u"],
  });
});
