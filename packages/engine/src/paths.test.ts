import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { statePaths } from "./paths.ts";

test("default layout: characters/gallery under the cwd, config under the home root", () => {
  const paths = statePaths({}, "/work/my-project");
  assert.equal(paths.charactersDir, join("/work/my-project", "characters"));
  assert.equal(paths.galleryDir, join("/work/my-project", "gallery"));
  // The API key stays global — it must never land inside a committable project.
  assert.equal(paths.root, join(homedir(), ".character-gen"));
  assert.equal(paths.configFile, join(homedir(), ".character-gen", "config.json"));
});

test("CHARACTER_GEN_HOME relocates every path under one directory", () => {
  const paths = statePaths({ CHARACTER_GEN_HOME: "/isolated" }, "/work/my-project");
  assert.equal(paths.root, "/isolated");
  assert.equal(paths.configFile, join("/isolated", "config.json"));
  assert.equal(paths.charactersDir, join("/isolated", "characters"));
  assert.equal(paths.galleryDir, join("/isolated", "gallery"));
});

test("an empty CHARACTER_GEN_HOME is ignored, not treated as a root", () => {
  const paths = statePaths({ CHARACTER_GEN_HOME: "" }, "/work/my-project");
  assert.equal(paths.charactersDir, join("/work/my-project", "characters"));
  assert.equal(paths.root, join(homedir(), ".character-gen"));
});

test("the cwd parameter defaults to process.cwd()", () => {
  const paths = statePaths({});
  assert.equal(paths.charactersDir, join(process.cwd(), "characters"));
  assert.equal(paths.galleryDir, join(process.cwd(), "gallery"));
});
