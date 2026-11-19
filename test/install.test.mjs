// Tests install.mjs: copies and verifies the core, registers the agents of a config file once, issues tokens only once, keeps a root's dialect, and installs tr-v1 roots under their own file names.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DIALECTS } from "../src/agent-post.mjs";
import { CORE, cleanEnv, fake } from "./helpers.mjs";

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

/** A registry as 0.1.0 left it: no `installed` or `default` marks; codex was bound to the folder its MCP server
 * started in (the lead's repository), a worktree's codex record inside it, and someone registered the reserved name
 * `lead` first from elsewhere. Written directly, in the 0.1.0 shape. */
function oldRegistry(root, base, takenToken) {
  const record = (name, kind, folder, token = null) => ({
    name,
    kind,
    account: null,
    folder,
    registered_at: "2026-11-01T10:00:00+00:00",
    last_seen: "2026-11-01T10:00:00+00:00",
    status: "idle",
    quota_note: null,
    token_digest: token ? crypto.createHash("sha256").update(token, "utf8").digest("hex") : null,
  });
  const registry = {
    v: 1,
    agents: {
      lead: record("lead", "claude", path.join(base, "elsewhere"), takenToken),
      codex: record("codex", "codex", path.join(base, "repo")),
      "codex-old": record("codex-old", "codex", path.join(base, "repo", "worktrees", "x")),
      "codex-tree": record("codex-tree", "codex", path.join(base, "codex-tree")),
    },
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "agents.json"), JSON.stringify(registry));
  fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ dialect: "en" }));
  return registry;
}

test("upgrading a 0.1.0 root: the config's agents are corrected, a reserved name is taken back, others are kept", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-upgrade-"));
  const root = path.join(base, "post");
  const takenToken = fake("agp_", "heldbysomeoneelse", "0".repeat(18));
  const old = oldRegistry(root, base, takenToken);
  const config = path.join(base, "agents.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      agents: [
        { name: "lead", kind: "claude", folder: "./repo", default: true, reserved: true },
        { name: "helper", kind: "claude", folder: "./repo" },
        { name: "codex", kind: "codex" },
        { name: "operator", kind: "assistant", reserved: true, protected: true },
      ],
    }),
  );
  const first = install("--config", config, "--root", root);
  assert.equal(first.status, 0, first.stderr);
  const { report } = first;
  assert.deepEqual(report.added, ["helper", "operator"]);
  assert.deepEqual(report.corrected, { lead: ["folder", "default", "installed"], codex: ["folder", "installed"] });
  assert.deepEqual(report.taken_back, ["lead"]);
  assert.deepEqual([report.kept, report.unbound], [["codex-tree"], ["codex-old"]]);
  assert.deepEqual([report.reserved, report.protected], [["lead", "operator"], ["operator"]]);
  // tokens only for the new agents and the name taken back
  assert.deepEqual(Object.keys(report.tokens).sort(), ["helper", "lead", "operator"]);
  assert.match(report.where.lead, /reserved name acts only with its token/);
  const { agents, verifySender, folderAgent } = await import(pathToFileURL(report.file).href);
  const now = agents(root);
  assert.equal(now.lead.folder, path.join(base, "repo"));
  assert.equal(now.codex.folder, null);
  assert.equal(now["codex-old"].folder, null);
  assert.deepEqual(now["codex-tree"], old.agents["codex-tree"]);
  assert.equal(folderAgent(root, path.join(base, "repo", "worktrees", "w")), "lead");
  assert.throws(() => verifySender(root, "lead", { token: takenToken, quiet: true }), { code: "invalid_token" });
  assert.equal(verifySender(root, "lead", { token: report.tokens.lead, quiet: true }), "token");
  // a second run has nothing left to do and prints no token
  const again = install("--config", config, "--root", root).report;
  assert.deepEqual(
    [again.added, again.corrected, again.taken_back, again.unbound, again.tokens],
    [[], {}, [], [], {}],
  );
  assert.equal(verifySender(root, "lead", { token: report.tokens.lead, quiet: true }), "token");
  assert.ok(!fs.readFileSync(path.join(root, "log.jsonl"), "utf8").includes(report.tokens.lead));
});

test("install refuses a codex agent bound to an installed Claude agent's folder, and a name listed twice", () => {
  const { base, root } = setup();
  const config = path.join(base, "bad.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ agents: [{ name: "lead", kind: "claude", folder: "./repo" }, { name: "codex", kind: "codex", folder: "./repo/sub" }] }),
  );
  const refused = install("--config", config, "--root", root);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /codex: an agent of kind codex cannot be bound/);
  fs.writeFileSync(config, JSON.stringify({ agents: [{ name: "a-1", kind: "api" }, { name: "a-1", kind: "api" }] }));
  assert.match(install("--config", config, "--root", path.join(base, "other")).stderr, /more than once: a-1/);
});

test("a root that never used reserved or protected agents gets no new settings; a config that drops them clears them", () => {
  const { base, config, root } = setup();
  assert.equal(install("--config", config, "--root", root).status, 0);
  const settings = () => JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(settings()).sort(), ["approver", "dialect"]);
  const marked = path.join(base, "marked.json");
  fs.writeFileSync(marked, JSON.stringify({ agents: [{ name: "operator", kind: "assistant", reserved: true, protected: true }], protect_unaddressed: true }));
  assert.equal(install("--config", marked, "--root", root).status, 0);
  assert.deepEqual([settings().reserved_names, settings().protected_agents, settings().protect_unaddressed], [["operator"], ["operator"], true]);
  fs.writeFileSync(marked, JSON.stringify({ agents: [{ name: "operator", kind: "assistant" }] }));
  assert.equal(install("--config", marked, "--root", root).status, 0);
  assert.deepEqual([settings().reserved_names, settings().protected_agents], [[], []]);
});
