// Tests install.mjs: copies and verifies the core, registers the agents of a config file once, issues tokens only once, keeps a root's dialect, and installs tr-v1 roots under their own file names.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DIALECTS } from "../src/agent-post.mjs";
import { CORE, cleanEnv } from "./helpers.mjs";

const INSTALL = fileURLToPath(new URL("../install.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/agents.example.json", import.meta.url));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function install(...args) {
  const result = spawnSync(process.execPath, [INSTALL, ...args], { env: cleanEnv(), encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, report: result.status === 0 ? JSON.parse(result.stdout) : null };
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-install-"));
  const config = path.join(base, "agents.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      approver: "the maintainer",
      agents: [
        { name: "alice", kind: "claude", account: "personal", folder: "./projects/alice" },
        { name: "bob", kind: "codex", token_hint: "Codex: env of the MCP server entry" },
        { name: "operator", kind: "assistant" },
      ],
    }),
  );
  return { base, config, root: path.join(base, "post") };
}

test("install copies and verifies the core, registers the config's agents and prints each new token once", () => {
  const { base, config, root } = setup();
  const first = install("--config", config, "--root", root);
  assert.equal(first.status, 0, first.stderr);
  const { report } = first;
  assert.equal(report.dialect, "en");
  assert.equal(report.file, path.join(root, "bin", "agent-post.mjs"));
  assert.equal(report.sha256, sha(CORE));
  assert.equal(sha(report.file), sha(CORE));
  assert.deepEqual(report.added, ["alice", "bob", "operator"]);
  assert.deepEqual(Object.keys(report.tokens), ["alice", "bob", "operator"]);
  assert.match(report.tokens.bob, /^agp_[A-Za-z0-9_-]{32}$/);
  assert.equal(report.where.bob, "Codex: env of the MCP server entry");
  assert.match(report.where.alice, /folder/);
  assert.match(report.where.operator, /AGENT_POST_TOKEN/);
  const registry = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8"));
  assert.equal(registry.agents.alice.folder, path.join(base, "projects", "alice"));
  assert.equal(registry.agents.alice.account, "personal");
  assert.ok(!JSON.stringify(registry).includes(report.tokens.bob));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")), { dialect: "en", approver: "the maintainer" });

  const again = install("--config", config, "--root", root, "--issue-tokens", "--mode", "strict");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([again.report.added, again.report.tokens, again.report.token_mode], [[], {}, "strict"]);
});

test("install keeps an existing root's dialect, writes tr-v1 roots under their own names and rejects a dialect change", () => {
  const { config, root } = setup();
  const tr = install("--config", config, "--root", root, "--dialect", "tr-v1");
  assert.equal(tr.status, 0, tr.stderr);
  assert.equal(tr.report.file, path.join(root, "bin", "posta.mjs"));
  assert.match(tr.report.tokens.operator, /^ajp_/);
  assert.match(tr.report.where.operator, /AJAN_POSTA_BELIRTEC/);
  const registry = JSON.parse(fs.readFileSync(path.join(root, "ajanlar.json"), "utf8"));
  assert.equal(registry.ajanlar.operator.tur, DIALECTS["tr-v1"].values.assistant);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "ayarlar.json"), "utf8")), { dialect: "tr-v1", onaylayan: "the maintainer" });
  const kept = install("--root", root);
  assert.equal(kept.report.dialect, "tr-v1");
  const changed = install("--root", root, "--dialect", "en");
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /uses the tr-v1 dialect/);
});

test("the example config installs as it is", () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-example-")), "post");
  const result = install("--config", EXAMPLE, "--root", root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.report.agents, ["alice", "codex", "operator"]);
  assert.equal(install("--config", EXAMPLE, "--root", root, "--mode", "loose").status, 1);
});

test("the Codex examples name an agent that the example config registers", () => {
  const names = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).agents.map((agent) => agent.name);
  const config = fs.readFileSync(fileURLToPath(new URL("../integrations/codex/config.example.toml", import.meta.url)), "utf8");
  const rules = fs.readFileSync(fileURLToPath(new URL("../integrations/codex/AGENTS.example.md", import.meta.url)), "utf8");
  const readme = fs.readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const asConfig = config.match(/"--as", "([a-z0-9-]+)"/)[1];
  assert.ok(names.includes(asConfig), asConfig);
  assert.equal(rules.match(/You are the agent `([a-z0-9-]+)`/)[1], asConfig);
  assert.equal(readme.match(/with `--as ([a-z0-9-]+)`/)[1], asConfig);
});
