import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const paths = {
  rootInstructions: "AGENTS.md",
  appInstructions: "app/AGENTS.md",
  skill: ".agents/skills/ship-linelight-change/SKILL.md",
  skillMetadata: ".agents/skills/ship-linelight-change/agents/openai.yaml",
  investigator: ".codex/agents/linelight-investigator.toml",
};

test("keeps project agent customizations discoverable and internally consistent", async () => {
  await Promise.all(Object.values(paths).map((path) => stat(path)));
  const [root, app, skill, metadata, investigator] = await Promise.all(
    Object.values(paths).map((path) => readFile(path, "utf8")),
  );

  for (const path of [
    paths.appInstructions,
    paths.skill,
    paths.investigator,
  ]) {
    assert.ok(root.includes(path), `AGENTS.md must link to ${path}`);
  }
  assert.ok(
    app.includes("../docs/codebase-index.md"),
    "app instructions must route agents through the ownership index",
  );

  assert.match(
    skill,
    /^---\nname: ship-linelight-change\ndescription: .+\n---\n/u,
  );
  assert.doesNotMatch(skill, /\bTODO\b|\[TODO/iu);
  assert.match(metadata, /display_name: "Ship a LineLight Change"/u);
  assert.match(metadata, /\$ship-linelight-change/u);

  assert.match(investigator, /^name = "linelight_investigator"$/mu);
  assert.match(investigator, /^description = ".+"$/mu);
  assert.match(investigator, /^sandbox_mode = "read-only"$/mu);
  assert.match(investigator, /^developer_instructions = """$/mu);
  assert.doesNotMatch(
    investigator,
    /^(?:model|model_reasoning_effort)\s*=/mu,
    "the project investigator should inherit current model defaults",
  );
});
