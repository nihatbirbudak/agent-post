// Tests the package contents: `npm pack --dry-run` lists exactly the allow-listed files, and package.json declares the module type, the command, Node 20+ and the MIT license.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// The package contents, written out: a new file in a packed folder must be added here on purpose.
const ALLOWED = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "bin/agent-post.mjs",
  "docs/design.md",
  "docs/format.md",
  "docs/routing.md",
  "docs/tr/README.md",
  "examples/agents.example.json",
  "examples/router.example.mjs",
  "install.mjs",
  "integrations/claude-code/hooks.example.json",
  "integrations/claude-code/skill/SKILL.md",
  "integrations/codex/AGENTS.example.md",
  "integrations/codex/config.example.toml",
  "package.json",
  "src/agent-post.mjs",
];

test("npm pack lists exactly the allow-listed files", () => {
  const result = spawnSync("npm pack --dry-run --json --ignore-scripts", { cwd: ROOT, shell: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout)[0].files.map((file) => file.path).sort();
  assert.deepEqual(packed, [...ALLOWED].sort());
});

test("package.json declares the module type, the command, Node 20+, the MIT license and no runtime dependencies", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "agent-post");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.bin, { "agent-post": "bin/agent-post.mjs" });
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.dependencies, undefined);
  assert.ok(Object.values(pkg.devDependencies).every((version) => /^\d+\.\d+\.\d+$/.test(version)), "dev dependencies are pinned");
  assert.ok(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8").startsWith(`MIT License\n\nCopyright (c) 2026 ${pkg.author}\n`));
});
