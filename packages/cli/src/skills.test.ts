// Drift protection for the Claude Code skills: frontmatter must parse and every
// CLI command a skill tells Claude to run must actually exist in this CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_STEPS } from "@character-gen/engine";
import { COMMAND_HELP, ROOT_HELP } from "./help.ts";
import { STUBS } from "./run.ts";

const SKILLS_DIR = join(import.meta.dirname, "..", "..", "..", "skills");

const EXPECTED_SKILLS = ["character-gen", "character-turnaround", "create-character"];

interface Skill {
  dir: string;
  frontmatter: string;
  body: string;
}

function loadSkill(dir: string): Skill {
  const raw = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/u.exec(raw);
  assert.ok(match, `${dir}/SKILL.md must start with a --- frontmatter block`);
  const [, frontmatter, body] = match;
  assert.ok(frontmatter !== undefined && body !== undefined);
  return { dir, frontmatter, body };
}

function skillDirs(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

test("the expected skills exist", () => {
  assert.deepEqual(skillDirs(), EXPECTED_SKILLS);
});

test("every skill has parseable frontmatter with name and description", () => {
  for (const dir of skillDirs()) {
    const skill = loadSkill(dir);
    const name = /^name: (.+)$/mu.exec(skill.frontmatter)?.[1]?.trim();
    const description = /^description: (.+)$/mu.exec(skill.frontmatter)?.[1]?.trim();
    assert.equal(name, dir, `${dir}: frontmatter name must match the directory`);
    assert.ok(description && description.length > 20, `${dir}: description missing or too short`);
  }
});

/** Code spans/fences only — prose may say "the character-gen CLI". */
function codeChunks(body: string): string[] {
  return body.match(/```[\s\S]*?```|`[^`\n]+`/gu) ?? [];
}

test("every CLI command referenced in a skill's code exists and is not a stub", () => {
  const commands = new Set(Object.keys(COMMAND_HELP));
  for (const dir of skillDirs()) {
    const skill = loadSkill(dir);
    let references = 0;
    for (const chunk of codeChunks(skill.body)) {
      for (const match of chunk.matchAll(/character-gen\s+([a-z][a-z-]*)/gu)) {
        references += 1;
        const command = match[1];
        assert.ok(
          command !== undefined && commands.has(command),
          `${dir}: references unknown command "character-gen ${command}"`,
        );
        // A skill must never direct Claude at a recognized-but-unbuilt command.
        assert.ok(
          !STUBS.has(command),
          `${dir}: references not-yet-implemented command "character-gen ${command}"`,
        );
      }
    }
    assert.ok(references > 0, `${dir}: expected at least one CLI command reference`);
  }
});

test("every flag referenced in a skill's code appears in the CLI help", () => {
  const helpText = [ROOT_HELP, ...Object.values(COMMAND_HELP)].join("\n");
  for (const dir of skillDirs()) {
    const skill = loadSkill(dir);
    for (const chunk of codeChunks(skill.body)) {
      for (const match of chunk.matchAll(/(--[a-z][a-z-]*)/gu)) {
        const flag = match[1];
        assert.ok(
          flag !== undefined && helpText.includes(flag),
          `${dir}: references flag "${flag}" not present in any help text`,
        );
      }
    }
  }
});

test("every --steps list in a skill's code names only real pipeline steps", () => {
  const steps = new Set<string>(PIPELINE_STEPS);
  for (const dir of skillDirs()) {
    const skill = loadSkill(dir);
    for (const chunk of codeChunks(skill.body)) {
      for (const match of chunk.matchAll(/--steps\s+([a-z][a-z,]*)/gu)) {
        for (const step of (match[1] ?? "").split(",").filter((s) => s.length > 0)) {
          assert.ok(steps.has(step), `${dir}: --steps names unknown step "${step}"`);
        }
      }
    }
  }
});
