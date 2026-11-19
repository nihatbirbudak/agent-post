// Tests the identity rules in every dialect: reserved names (installer only, token only), a fixed kind, a fixed MCP identity, the default identity of a folder, kind codex kept out of an installed Claude agent's folder, separate Codex sessions, ownerless inboxes, verified status, locks and claims, last-seen times of reserved names, the protection gate and no token on the command line.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as post from "../src/agent-post.mjs";
import { DIALECT_NAMES, SCRIPT, cleanEnv, harness } from "./helpers.mjs";

for (const dialect of DIALECT_NAMES) {
  const h = harness(dialect);
  const { d, error } = h;
  const t = (name, body, options = {}) => test(`[${dialect}] ${name}`, options, body);
  const TOKEN = new RegExp(`${d.tokenPrefix}[A-Za-z0-9_-]{30,}`);

  /** A root in this dialect with the given settings (reserved names, protected agents). */
  function fresh(settings = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-identity-"));
    post.initRoot(root, { dialect, ...settings });
    return root;
  }
  const install = (root, name, kind, folder = null, isDefault = false) =>
    post.register(root, { name, kind, folder, install: true, default: isDefault });
  const code = (result) => (result.error ?? result.stderr ?? "").split(":")[0];
  const log = (root) => (fs.existsSync(post.layout(root).log) ? fs.readFileSync(post.layout(root).log, "utf8") : "");

  /** A real MCP server process (`mcp [--as]`) in `cwd`: runs the calls, returns each result or `{ error }`. */
  function server(root, cwd, calls, as = null, env = {}) {
    fs.mkdirSync(cwd, { recursive: true });
    const input = calls
      .map(([name, args], i) =>
        JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: h.tool(name), arguments: post.toDisk(root, args) } }),
      )
      .join("\n");
    const result = spawnSync(process.execPath, [SCRIPT, "mcp", ...(as ? [`--${h.flag("as")}`, as] : [])], {
      cwd,
      env: cleanEnv({ [d.env.root]: root, ...env }),
      input: `${input}\n`,
      encoding: "utf8",
    });
    const answers = new Map(result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((a) => [a.id, a.result]));
    return calls.map((_, i) => {
      const { content, isError } = answers.get(i + 1);
      return isError ? { error: content[0].text } : post.fromDisk(root, JSON.parse(content[0].text));
    });
  }

  // --- Reserved names ---------------------------------------------------------------------------------------

  t("a reserved name cannot be taken as a new registration from the CLI or MCP; each rejection is logged", () => {
    const root = fresh({ reserved_names: ["lead", "operator"] });
    const place = path.join(root, "work");
    assert.deepEqual(post.reservedNames(root), ["lead", "operator"]);
    for (const [name, kind] of [["lead", "claude"], ["operator", "assistant"]]) {
      const cli = h.run(root, place, ["register", name, h.value(kind)]);
      assert.equal(cli.status, 1);
      assert.equal(code(cli), error("reserved_name"));
      assert.equal(code(h.mcp(root, { me: null, folder: place }, "register", { name, kind })), error("reserved_name"));
    }
    assert.deepEqual(post.agents(root), {});
    assert.equal(h.logEvents(root, "reserved_name").length, 4);
    // the installer registers it
    assert.match(install(root, "lead", "claude", path.join(root, "lead")).token, TOKEN);
  });

  t("a registered reserved name: its own folder switches to it, but its token and folder change only through the installer", () => {
    const root = fresh({ reserved_names: ["lead", "lead-two"] });
    const repo = path.join(root, "repo");
    const first = install(root, "lead", "claude", repo, true);
    install(root, "lead-two", "claude", repo);
    const worktree = path.join(repo, "worktrees", "w");
    const switched = h.mcp(root, { me: null, folder: worktree }, "register", { name: "lead-two", kind: "claude" });
    assert.equal(switched.error, undefined);
    assert.equal(switched.token, undefined);
    for (const [args, token] of [
      [["register", "lead", "claude", "--new-token"], undefined],
      [["register", "lead", "claude", "--folder", path.join(repo, "worktrees")], undefined],
      [["register", "lead", "claude", "--new-token"], first.token],
    ]) {
      const refused = h.run(root, worktree, args, { token });
      assert.equal(refused.status, 1, args.join(" "));
      assert.equal(code(refused), error("reserved_name"));
    }
    assert.equal(code(h.mcp(root, { me: null, folder: worktree }, "register", { name: "lead", kind: "claude", new_token: true })), error("reserved_name"));
    const check = (token) => h.run(root, path.join(root, "elsewhere"), ["verify", "--from", "lead"], { token });
    assert.equal(check(first.token).json().verified, "token");
    assert.equal(post.agents(root).lead.folder, path.resolve(repo));
    const renewed = post.register(root, { name: "lead", kind: "claude", folder: repo, install: true, default: true, new_token: true });
    assert.notEqual(renewed.token, first.token);
    assert.equal(code(check(first.token)), error("invalid_token"));
  });

  t("acting as a reserved name needs its token, from any folder (CLI and MCP); register and the hook keep the folder", () => {
    const root = fresh({ reserved_names: ["lead", "operator"] });
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const operator = install(root, "operator", "assistant").token;
    const lead = install(root, "lead", "claude", repo, true).token;
    install(root, "worker", "api");
    // any process in the lead's folder: the name without a token is refused, the hook still picks it
    const forged = h.run(root, worktree, ["send", "operator", "--from", "lead", "--subject", "Reply", "--text", "ship it"]);
    assert.equal(code(forged), error("token_required"));
    assert.ok(!/AGENT_POST_TOKEN|AJAN_POSTA_BELIRTEC/.test(forged.stderr), forged.stderr);
    assert.equal(code(h.mcp(root, { me: null, folder: worktree }, "send", { to: "operator", subject: "Reply", text: "x" })), error("token_required"));
    assert.equal(post.folderAgent(root, worktree), "lead");
    assert.ok(!fs.existsSync(post.layout(root).inbox("operator")));
    // with the token from anywhere
    const outside = h.run(root, path.join(root, "t", "other-tree"), ["send", "operator", "--from", "lead", "--subject", "Reply", "--text", "ok"], { token: lead });
    assert.equal(outside.json().verified, "token", outside.stderr);
    const fromOperator = h.run(root, path.join(root, "srv"), ["send", "lead", "--from", "operator", "--subject", "a", "--text", "b"], { token: operator });
    assert.equal(fromOperator.json().verified, "token", fromOperator.stderr);
    // without it, even the verify query says so
    assert.equal(code(h.run(root, path.join(root, "srv"), ["send", "worker", "--from", "operator", "--subject", "a", "--text", "b"])), error("token_required"));
    assert.equal(code(h.run(root, path.join(root, "srv"), ["verify", "--from", "operator"])), error("token_required"));
    assert.deepEqual(post.inbox(root, "operator").map((m) => [m.from, m.verified]), [["lead", "token"]]);
  });

  t("a reserved name is seen only from exactly its folder or with its token: a worktree's hook, inbox read and register do not", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    fs.mkdirSync(worktree, { recursive: true });
    const lead = install(root, "lead", "claude", repo, true).token;
    const lastSeen = () => post.agents(root).lead.last_seen;
    const hook = (eventName, folder) => post.hook(eventName, JSON.stringify({ cwd: folder }), root);
    assert.equal(lastSeen(), null); // the installer never marks an agent seen
    for (const eventName of ["SessionStart", "UserPromptSubmit", "Stop"]) hook(eventName, worktree);
    assert.equal(h.run(root, worktree, ["inbox", "lead"]).status, 0);
    assert.equal(h.run(root, worktree, ["summary", "lead"]).status, 0);
    assert.equal(h.mcp(root, { me: null, folder: worktree }, "inbox", {}).error, undefined);
    assert.equal(h.mcp(root, { me: null, folder: worktree }, "register", { name: "lead", kind: "claude" }).error, undefined);
    assert.equal(lastSeen(), null, "a worktree session showed the closed owner as alive");
    hook("Stop", repo);
    assert.ok(lastSeen());
    const reset = () => {
      const raw = JSON.parse(fs.readFileSync(post.layout(root).agents, "utf8"));
      raw[h.key("agents")].lead[h.key("last_seen")] = null;
      fs.writeFileSync(post.layout(root).agents, JSON.stringify(raw));
    };
    reset();
    assert.equal(h.run(root, worktree, ["inbox", "lead"], { token: lead }).status, 0);
    assert.ok(lastSeen());
    // other names are seen from inside their folder as before
    install(root, "helper", "claude", path.join(root, "helper"));
    hook("Stop", path.join(root, "helper", "sub"));
    assert.ok(post.agents(root).helper.last_seen);
  });

  // --- Kind, fixed identity, default identity ----------------------------------------------------------------

  t("a registered agent's kind never changes: a codex agent cannot register itself again as claude", () => {
    const root = fresh();
    const tree = path.join(root, "codex-tree");
    post.register(root, { name: "codex-map", kind: "codex", folder: tree });
    const cli = h.run(root, tree, ["register", "codex-map", "claude"]);
    assert.equal(cli.status, 1);
    assert.equal(code(cli), error("kind_immutable"));
    assert.equal(code(h.mcp(root, { me: null, folder: tree }, "register", { name: "codex-map", kind: "claude" })), error("kind_immutable"));
    assert.equal(post.agents(root)["codex-map"].kind, "codex");
    assert.equal(h.logEvents(root, "kind_immutable").length, 2);
    // the installer corrects a kind
    assert.deepEqual(post.register(root, { name: "codex-map", kind: "claude", folder: tree, install: true }).corrected, ["kind", "installed"]);
  });

  t("the session folder: stored for claude; for codex only away from an installed Claude agent's folder; never for api or assistant", () => {
    const root = fresh();
    const repo = path.join(root, "repo");
    install(root, "lead", "claude", repo, true);
    const inRepo = { me: null, folder: repo };
    const codex = h.mcp(root, inRepo, "register", { name: "codex-repo", kind: "codex" });
    const api = h.mcp(root, { me: null, folder: repo }, "register", { name: "api-worker", kind: "api" });
    const assistant = h.mcp(root, { me: null, folder: repo }, "register", { name: "helper", kind: "assistant" });
    const claude = h.mcp(root, { me: null, folder: repo }, "register", { name: "reviewer-x", kind: "claude" });
    assert.deepEqual([codex.folder, api.folder, assistant.folder, claude.folder], [null, null, null, path.resolve(repo)]);
    const explicit = h.mcp(root, { me: null, folder: repo }, "register", { name: "codex-in", kind: "codex", folder: repo });
    assert.equal(code(explicit), error("codex_folder_forbidden"));
    // a worktree inside the repository is forbidden too, by itself or explicitly
    const inside = path.join(repo, "worktrees", "w");
    assert.equal(h.mcp(root, { me: null, folder: inside }, "register", { name: "codex-tree", kind: "codex" }).folder, null);
    assert.equal(code(h.mcp(root, { me: null, folder: inside }, "register", { name: "codex-tree-2", kind: "codex", folder: inside })), error("codex_folder_forbidden"));
    // Codex's own tree elsewhere (even with the same folder name) is bound by itself
    const own = path.join(root, ".codex", "worktrees", "a", "repo");
    assert.equal(h.mcp(root, { me: null, folder: own }, "register", { name: "codex-own", kind: "codex" }).folder, path.resolve(own));
    assert.equal(code(h.run(root, repo, ["register", "codex-cli", "codex", "--folder", repo])), error("codex_folder_forbidden"));
    assert.deepEqual(Object.values(post.agents(root)).filter((a) => a.kind === "codex" && a.folder).map((a) => a.name), ["codex-own"]);
    assert.equal(h.logEvents(root, "codex_folder_forbidden").length, 3);
  });

  t("an MCP server started with --as keeps its kind: it switches only to a same-kind name that is free or proven", () => {
    const root = fresh({ reserved_names: ["lead", "operator"] });
    const repo = path.join(root, "repo");
    install(root, "lead", "claude", repo, true);
    install(root, "codex", "codex");
    install(root, "operator", "assistant");
    const own = path.join(root, ".codex", "worktrees", "a", "repo");
    assert.equal(server(root, own, [["register", { name: "codex-bound", kind: "codex" }]])[0].folder, path.resolve(own));
    const [b] = server(root, repo, [["register", { name: "codex-b", kind: "codex" }]], "codex");
    const [self, lead, claudeName, sent, switched, after, reserved, bound, other, proven] = server(
      root,
      repo,
      [
        ["register", { name: "codex", kind: "codex" }],
        ["register", { name: "lead", kind: "claude" }],
        ["register", { name: "claude-new", kind: "claude" }],
        ["send", { to: "lead", subject: "a", text: "b" }],
        ["register", { name: "codex-task", kind: "codex" }],
        ["register", { name: "lead", kind: "claude" }],
        ["register", { name: "operator", kind: "assistant" }],
        ["register", { name: "codex-bound", kind: "codex" }],
        ["register", { name: "codex-b", kind: "codex" }],
        ["register", { name: "codex-b", kind: "codex", token: b.token }],
      ],
      "codex",
    );
    assert.equal(self.error, undefined);
    for (const refused of [lead, claudeName, after, reserved, bound, other]) assert.equal(code(refused), error("identity_fixed"), JSON.stringify(refused));
    assert.equal(sent.error, undefined);
    assert.equal(switched.name, "codex-task");
    assert.equal(proven.name, "codex-b");
    assert.ok(!post.agents(root)["claude-new"]);
    assert.equal(h.logEvents(root, "identity_fixed").length, 6);
    // a session started inside its own tree switches to its name there
    assert.equal(server(root, own, [["register", { name: "codex-bound", kind: "codex" }]], "codex")[0].name, "codex-bound");
  });

  t("default identity: the folder's only Claude agent; with several the installer's default; none for a codex-only folder", () => {
    const root = fresh();
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const summary = (folder) => post.hook("UserPromptSubmit", JSON.stringify({ cwd: folder }), root);
    post.register(root, { name: "codex", kind: "codex", folder: repo });
    post.send(root, { from: "codex", to: "codex", subject: "codex work", text: "x" });
    assert.equal(post.folderAgent(root, worktree), null);
    assert.equal(summary(worktree), "");
    install(root, "lead-two", "claude", repo);
    install(root, "lead", "claude", repo, true);
    post.send(root, { from: "lead-two", to: "lead", subject: "To the lead", text: "x" });
    assert.equal(post.folderAgent(root, worktree), "lead");
    assert.match(summary(worktree), /\(lead\)/);
    const shared = path.join(root, "shared");
    post.register(root, { name: "claude-a", kind: "claude", folder: shared });
    post.register(root, { name: "claude-b", kind: "claude", folder: shared });
    assert.equal(post.folderAgent(root, shared), null);
    const only = path.join(root, "only");
    post.register(root, { name: "claude-only", kind: "claude", folder: only });
    assert.equal(post.folderAgent(root, path.join(only, "sub")), "claude-only");
    const state = { me: null, folder: shared };
    assert.equal(code(h.mcp(root, state, "inbox", {})), error("not_registered"));
    assert.equal(h.mcp(root, state, "register", { name: "claude-b", kind: "claude" }).name, "claude-b");
    assert.deepEqual(h.mcp(root, state, "inbox", {}), []);
  });

  t("kind codex is kept out of an installed Claude agent's folder however the path is spelled", { skip: process.platform !== "win32" }, () => {
    const root = fresh();
    const repo = path.join(root, "Long Repository Name");
    const tree = path.join(repo, "worktrees", "long-tree-name");
    fs.mkdirSync(tree, { recursive: true });
    install(root, "lead", "claude", repo, true);
    const link = path.join(root, "link");
    fs.symlinkSync(repo, link, "junction");
    const short = spawnSync("cmd.exe", ["/d", "/c", `for %I in ("${repo}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
    const spellings = {
      upper: repo.toUpperCase(),
      separators: `${repo}${path.sep}${path.sep}`,
      slashes: repo.replaceAll("\\", "/"),
      parent: path.join(tree, "..", "..", ".."),
      sibling: path.join(tree, "..", "long-tree-name"),
      link,
      inLink: path.join(link, "worktrees", "long-tree-name"),
      short,
    };
    for (const [name, folder] of Object.entries(spellings)) {
      assert.equal(post.codexFolderForbidden(root, folder), true, `${name}: ${folder}`);
      assert.equal(h.mcp(root, { me: null, folder }, "register", { name: `codex-${name.toLowerCase()}`, kind: "codex" }).folder, null, name);
    }
    assert.equal(post.codexFolderForbidden(root, path.join(root, ".codex", "worktrees", "x", "Long Repository Name")), false);
    assert.equal(post.codexFolderForbidden(root, `${repo}-copy`), false);
  });

  // --- Codex sessions and their inboxes ----------------------------------------------------------------------

  t("two Codex sessions keep separate identities: each reads its own inbox, not the other's", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const lead = install(root, "lead", "claude", repo, true).token;
    install(root, "codex", "codex");
    const [a] = server(root, repo, [["register", { name: "codex-a", kind: "codex" }]], "codex");
    assert.equal(a.folder, null);
    assert.ok(Number.isInteger(post.agents(root)["codex-a"].owner_pid));
    post.setOwner(root, "codex-a", process.pid); // the session stays open: this process stands in for it
    const [b, fromB] = server(root, repo, [["register", { name: "codex-b", kind: "codex" }], ["send", { to: "codex-a", subject: "from B", text: "x" }]], "codex");
    assert.equal(fromB.verified, "token");
    post.setOwner(root, "codex-b", process.pid);
    post.send(root, { from: "lead", to: "codex-b", subject: "for B only", text: "y", token: lead });
    // a session without codex-b's token switches to the name but cannot open the inbox or mark it
    const state = { me: null, folder: repo };
    assert.equal(h.mcp(root, state, "register", { name: "codex-b", kind: "codex" }).name, "codex-b");
    assert.equal(code(h.mcp(root, state, "inbox", {})), error("inbox_identity_required"));
    assert.equal(code(h.mcp(root, state, "mark_read", { ids: [post.inbox(root, "codex-b")[0].id] })), error("inbox_identity_required"));
    for (const args of [["inbox", "codex-b"], ["mark-read", "codex-b", `${d.ids.message}-abcdefgh-123456`], ["summary", "codex-b"]]) {
      const refused = h.run(root, repo, args);
      assert.equal(code(refused), error("inbox_identity_required"), args.join(" "));
    }
    assert.deepEqual(h.run(root, repo, ["inbox", "codex-b"], { token: b.token }).json().map((m) => m.subject), ["for B only"]);
    assert.equal(post.inbox(root, "codex-b", { unread: true }).length, 1);
    // the shared installed `codex` inbox opens only with codex's token as well
    assert.equal(code(server(root, repo, [["inbox", {}]], "codex")[0]), error("inbox_identity_required"));
    assert.equal(h.logEvents(root, "inbox_identity_required").length, 6);
  });

  t("a folderless Codex inbox whose session ended refuses new mail and tasks; an open session gets them", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const lead = install(root, "lead", "claude", repo, true).token;
    install(root, "codex", "codex");
    const write = (to, subject) => h.run(root, repo, ["send", to, "--from", "lead", "--subject", subject, "--text", "x"], { token: lead });
    // a session registers, gets mail while this test process stands in for it, then ends
    server(root, repo, [["register", { name: "codex-open", kind: "codex" }]], "codex");
    const ended = post.agents(root)["codex-open"].owner_pid;
    post.setOwner(root, "codex-open", process.pid);
    assert.equal(write("codex-open", "while open").status, 0);
    const task = post.openTask(root, { from: "lead", to: "codex-open", title: "Job", text: "x", token: lead });
    assert.ok(task.id);
    post.setOwner(root, "codex-open", ended);
    const refused = write("codex-open", "after it ended");
    assert.equal(refused.status, 1);
    assert.equal(code(refused), error("recipient_unowned"));
    const count = post.tasks(root).length;
    assert.throws(() => post.openTask(root, { from: "lead", to: "codex-open", title: "Job 2", text: "x", token: lead }), { code: "recipient_unowned" });
    assert.equal(post.tasks(root).length, count);
    assert.equal(post.inbox(root, "codex-open").length, 2);
    // never owned by a session (a persistent token in the app's configuration): delivered
    assert.equal(write("codex", "persistent").status, 0);
    // bound to its own tree: a new session opens it again, delivered
    server(root, path.join(root, ".codex", "worktrees", "t", "repo"), [["register", { name: "codex-tree", kind: "codex" }]]);
    assert.equal(write("codex-tree", "to the tree").status, 0);
    const lines = h.logEvents(root, "recipient_unowned");
    assert.deepEqual(lines.map((e) => e.agent), ["codex-open", "codex-open"]);
    assert.ok(lines.every((e) => !("subject" in e) && !("text" in e)));
  });

  t("a persistent Codex identity (--as with the token in the environment) is not tied to one session", () => {
    const root = fresh();
    install(root, "lead", "claude", path.join(root, "repo"), true);
    const codex = install(root, "codex", "codex").token;
    const [again] = server(root, path.join(root, "repo"), [["register", { name: "codex", kind: "codex" }]], "codex", { [d.env.token]: codex });
    assert.equal(again.error, undefined);
    assert.equal(post.agents(root).codex.owner_pid, undefined);
    assert.equal(post.send(root, { from: "lead", to: "codex", subject: "later", text: "x", folder: path.join(root, "repo") }).verified, "folder");
  });

  t("the name of a Codex session bound to its own tree cannot be written or read from elsewhere", () => {
    const root = fresh();
    const own = path.join(root, ".codex", "worktrees", "a", "repo", "tool");
    const elsewhere = path.join(root, ".codex", "worktrees", "b", "repo");
    assert.equal(h.mcp(root, { me: null, folder: own }, "register", { name: "codex-tool", kind: "codex" }).folder, path.resolve(own));
    assert.equal(code(h.run(root, elsewhere, ["send", "codex-tool", "--from", "codex-tool", "--subject", "a", "--text", "b"])), error("identity_mismatch"));
    assert.equal(code(h.run(root, elsewhere, ["inbox", "codex-tool"])), error("identity_mismatch"));
    assert.equal(code(h.mcp(root, { me: null, folder: elsewhere }, "register", { name: "codex-tool", kind: "codex" })), error("identity_mismatch"));
    const state = { me: null, folder: own };
    assert.equal(h.mcp(root, state, "register", { name: "codex-tool", kind: "codex" }).error, undefined);
    assert.deepEqual(h.mcp(root, state, "inbox", {}), []);
  });

  // --- Status, locks and claims need a verified identity ---------------------------------------------------

  t("status is written only for a verified agent: a tokenless codex is not marked seen, a worktree cannot set its lead's status", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const codexRoot = path.join(root, "codex-project");
    const lead = install(root, "lead", "claude", repo, true).token;
    const codex = install(root, "codex", "codex").token;
    assert.equal(h.mcp(root, { me: null, folder: path.join(root, "worker") }, "register", { name: "claude-worker", kind: "claude" }).error, undefined);
    const registry = () => post.agents(root);
    const cli = h.run(root, codexRoot, ["status", "codex", h.value("working")]);
    assert.equal(cli.status, 1);
    assert.equal(code(cli), error("identity_required"));
    assert.equal(code(h.mcp(root, { me: "codex", fixed: true, folder: codexRoot }, "set_status", { status: "working" })), error("identity_required"));
    assert.deepEqual([registry().codex.last_seen, registry().codex.status], [null, "idle"]);
    assert.equal(code(h.run(root, worktree, ["status", "lead", h.value("quota_full"), "--quota-note", "forged"])), error("token_required"));
    assert.equal(code(h.mcp(root, { me: null, folder: worktree }, "set_status", { status: "quota_full" })), error("token_required"));
    assert.equal(code(h.run(root, path.join(root, "elsewhere"), ["status", "claude-worker", h.value("quota_full")])), error("identity_mismatch"));
    assert.equal(registry().lead.status, "idle");
    assert.equal(h.run(root, codexRoot, ["status", "codex", h.value("working")], { token: codex }).status, 0);
    assert.ok(registry().codex.last_seen);
    assert.equal(h.run(root, worktree, ["status", "lead", h.value("quota_full")], { token: lead }).status, 0);
    assert.equal(h.mcp(root, { me: null, folder: path.join(root, "worker") }, "set_status", { status: "working" }).status, "working");
    assert.deepEqual([registry().codex.status, registry().lead.status, registry()["claude-worker"].status], ["working", "quota_full", "working"]);
    assert.equal(h.logEvents(root, "identity_required").filter((e) => e.operation === "status").length, 2);
  });

  t("locks are taken and released only for a verified agent: nobody locks or unlocks in another agent's name", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const workerFolder = path.join(root, "worker");
    const elsewhere = path.join(root, "elsewhere");
    const lead = install(root, "lead", "claude", repo, true).token;
    install(root, "codex", "codex");
    h.mcp(root, { me: null, folder: workerFolder }, "register", { name: "claude-worker", kind: "claude" });
    assert.equal(h.run(root, worktree, ["lock", "lead", "--area", path.join(root, "shared", "lead")], { token: lead }).status, 0);
    assert.equal(h.mcp(root, { me: null, folder: workerFolder }, "lock", { areas: [path.join(root, "shared", "worker")] }).error, undefined);
    const owners = () => post.locks(root).map((l) => l.owner).sort();
    assert.deepEqual(owners(), ["claude-worker", "lead"]);
    assert.equal(code(h.run(root, worktree, ["unlock", "lead"])), error("token_required"));
    assert.equal(code(h.run(root, worktree, ["lock", "lead", "--area", path.join(root, "x")])), error("token_required"));
    assert.equal(code(h.mcp(root, { me: null, folder: worktree }, "unlock", {})), error("token_required"));
    assert.equal(code(h.run(root, elsewhere, ["unlock", "claude-worker"])), error("identity_mismatch"));
    assert.equal(code(h.run(root, elsewhere, ["lock", "codex", "--area", path.join(root, "z")])), error("identity_required"));
    assert.equal(code(h.mcp(root, { me: "codex", fixed: true, folder: elsewhere }, "lock", { areas: [path.join(root, "z")] })), error("identity_required"));
    assert.deepEqual(owners(), ["claude-worker", "lead"]);
    assert.equal(h.run(root, workerFolder, ["unlock", "claude-worker"]).status, 0);
    assert.equal(h.run(root, repo, ["unlock", "lead"], { token: lead }).status, 0);
    assert.deepEqual(post.locks(root), []);
  });

  t("claiming a task needs the claimer's identity on every task: a worktree cannot claim its lead's task in its name", () => {
    const root = fresh({ reserved_names: ["lead"] });
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const lead = install(root, "lead", "claude", repo, true).token;
    const worker = h.mcp(root, { me: null, folder: path.join(root, "worker") }, "register", { name: "claude-worker", kind: "claude" });
    const task = post.openTask(root, { from: "claude-worker", to: "lead", title: "Job", text: "x", areas: [path.join(root, "shared")], token: worker.token });
    const second = post.openTask(root, { from: "lead", to: "claude-worker", title: "Job 2", text: "x", token: lead });
    assert.equal(code(h.run(root, worktree, ["task-claim", task.id, "lead"])), error("token_required"));
    assert.equal(code(h.mcp(root, { me: null, folder: worktree }, "task_claim", { id: task.id })), error("token_required"));
    assert.equal(code(h.run(root, path.join(root, "elsewhere"), ["task-claim", second.id, "claude-worker"])), error("identity_mismatch"));
    assert.deepEqual([post.readTask(root, task.id).status, post.readTask(root, second.id).status], ["open", "open"]);
    assert.deepEqual(post.locks(root), []);
    assert.equal(h.run(root, worktree, ["task-claim", task.id, "lead"], { token: lead }).json().claimed_by, "lead");
    assert.equal(h.mcp(root, { me: null, folder: path.join(root, "worker") }, "task_claim", { id: second.id }).claimed_by, "claude-worker");
  });

  // --- Protection gate --------------------------------------------------------------------------------------

  t("protected agent: only installed, token-verified, non-codex senders reach it; logged without the text", () => {
    const root = fresh({ reserved_names: ["operator"], protected_agents: ["operator"], protect_unaddressed: true });
    const tree = path.join(root, "codex-tree");
    const operator = install(root, "operator", "assistant").token;
    const lead = install(root, "lead", "claude", path.join(root, "repo"), true).token;
    const worker = install(root, "api-worker", "api").token;
    post.register(root, { name: "codex-map", kind: "codex", folder: tree });
    const SUBJECT = "Open the door";
    assert.equal(code(h.run(root, tree, ["send", "operator", "--from", "codex-map", "--subject", SUBJECT, "--text", "details"])), error("protected_no_codex"));
    assert.throws(() => post.send(root, { from: "codex-map", to: "operator", kind: "reply", subject: "a", text: "b", folder: tree }), { code: "protected_no_codex" });
    assert.throws(() => post.openTask(root, { from: "codex-map", title: "Board", text: "x", folder: tree }), { code: "protected_no_codex" });
    assert.throws(() => post.openTask(root, { from: "codex-map", to: "operator", title: "For you", text: "x", folder: tree }), { code: "protected_no_codex" });
    assert.deepEqual(post.tasks(root), []);
    // a task the protected agent opened: codex cannot claim it, nor finish one it claimed before the rule
    const task = post.openTask(root, { from: "operator", title: "Chat job", text: "x", token: operator });
    assert.throws(() => post.claimTask(root, task.id, "codex-map", { folder: tree }), { code: "protected_no_codex" });
    const file = post.layout(root).task(task.id);
    fs.writeFileSync(file, JSON.stringify(post.toDisk(root, { ...post.readTask(root, task.id), status: "claimed", claimed_by: "codex-map" })));
    assert.throws(() => post.finishTask(root, task.id, "codex-map", { status: "done", result: "x", folder: tree }), { code: "protected_no_codex" });
    assert.equal(post.readTask(root, task.id).status, "claimed");
    assert.ok(!fs.existsSync(post.layout(root).inbox("operator")));
    // a name made up by anyone, and an installed agent without its token
    const made = h.run(root, path.join(root, "x"), ["register", "claude-fake", "claude"]).json().token;
    assert.equal(code(h.run(root, path.join(root, "x"), ["send", "operator", "--from", "claude-fake", "--subject", "a", "--text", "b"], { token: made })), error("protected_needs_install"));
    assert.equal(code(h.run(root, path.join(root, "x"), ["send", "operator", "--from", "api-worker", "--subject", "a", "--text", "b"])), error("protected_needs_token"));
    // installed agents with their token, and codex to anyone else
    post.send(root, { from: "lead", to: "operator", subject: "a", text: "b", token: lead });
    post.send(root, { from: "api-worker", to: "operator", subject: "note", text: "b", token: worker });
    post.send(root, { from: "codex-map", to: "lead", subject: "a", text: "b", folder: tree });
    const second = post.openTask(root, { from: "operator", title: "Job 2", text: "x", token: operator });
    assert.equal(post.claimTask(root, second.id, "api-worker", { token: worker }).claimed_by, "api-worker");
    post.finishTask(root, second.id, "api-worker", { status: "done", result: "Done.", token: worker });
    assert.deepEqual(post.inbox(root, "operator").map((m) => [m.from, m.kind]), [["lead", "message"], ["api-worker", "message"], ["api-worker", "reply"]]);
    const gate = ["protected_no_codex", "protected_needs_install", "protected_needs_token"].flatMap((event) => h.logEvents(root, event));
    assert.equal(gate.length, 8);
    assert.ok(gate.every((e) => !("subject" in e) && !("text" in e)));
    assert.ok(!log(root).includes(SUBJECT));
  });

  t("reserved names and protection are off without their settings (a 0.1.0 root works as before) and on with them", () => {
    const root = fresh();
    const repo = path.join(root, "repo");
    const worktree = path.join(repo, "worktrees", "w");
    const tree = path.join(root, "codex-tree");
    fs.mkdirSync(worktree, { recursive: true });
    install(root, "lead", "claude", repo, true);
    const operator = install(root, "operator", "assistant").token;
    post.register(root, { name: "codex-map", kind: "codex", folder: tree });
    const task = post.openTask(root, { from: "operator", title: "Job", text: "x", token: operator });
    const off = () => {
      assert.equal(post.send(root, { from: "lead", to: "operator", subject: "a", text: "b", folder: worktree }).verified, "folder");
      assert.equal(post.send(root, { from: "codex-map", to: "operator", subject: "a", text: "b", folder: tree }).verified, "folder");
      assert.equal(post.openTask(root, { from: "codex-map", title: "Board", text: "x", folder: tree }).status, "open");
      assert.equal(post.openTask(root, { from: "codex-map", to: "operator", title: "For you", text: "x", folder: tree }).status, "open");
    };
    off();
    assert.equal(post.register(root, { name: "spare", kind: "claude" }).name, "spare");
    post.hook("Stop", JSON.stringify({ cwd: worktree }), root);
    assert.ok(post.agents(root).lead.last_seen);
    assert.equal(post.claimTask(root, task.id, "codex-map", { folder: tree }).claimed_by, "codex-map");
    // protected without protect_unaddressed: a task without a recipient stays open to everyone
    post.initRoot(root, { dialect, protected_agents: ["operator"] });
    assert.equal(post.openTask(root, { from: "codex-map", title: "Board 2", text: "x", folder: tree }).status, "open");
    assert.throws(() => post.send(root, { from: "codex-map", to: "operator", subject: "a", text: "b", folder: tree }), { code: "protected_no_codex" });
    assert.throws(() => post.finishTask(root, task.id, "codex-map", { status: "done", result: "x", folder: tree }), { code: "protected_no_codex" });
    // on: the same calls are refused
    post.initRoot(root, { dialect, reserved_names: ["lead"], protect_unaddressed: true });
    assert.throws(() => post.send(root, { from: "lead", to: "operator", subject: "a", text: "b", folder: worktree }), { code: "token_required" });
    assert.throws(() => post.openTask(root, { from: "codex-map", title: "Board 3", text: "x", folder: tree }), { code: "protected_no_codex" });
    assert.throws(() => post.register(root, { name: "lead", kind: "claude", folder: path.join(repo, "moved") }), { code: "reserved_name" });
    assert.equal(post.register(root, { name: "spare-2", kind: "claude" }).name, "spare-2"); // not reserved: free
  });

  t("a protected agent's rejection tells the sender what to do", () => {
    const root = fresh({ protected_agents: ["operator"], protect_unaddressed: true });
    install(root, "operator", "assistant");
    const worker = install(root, "worker", "api").token;
    post.register(root, { name: "codex-map", kind: "codex", folder: path.join(root, "tree") });
    const made = post.register(root, { name: "made-up", kind: "api" }).token;
    const message = (call) => {
      try {
        call();
      } catch (rejected) {
        return rejected.message;
      }
      throw new Error("not rejected");
    };
    const hints = dialect === "en"
      ? [/not of kind codex/, /install config/, /AGENT_POST_TOKEN/]
      : [/Codex türü olmayan/, /kurulum yapılandırmasına/, /AJAN_POSTA_BELIRTEC/];
    assert.match(message(() => post.send(root, { from: "codex-map", to: "operator", subject: "a", text: "b", folder: path.join(root, "tree") })), hints[0]);
    assert.match(message(() => post.openTask(root, { from: "made-up", title: "a", text: "b", token: made })), hints[1]);
    assert.match(message(() => post.send(root, { from: "worker", to: "operator", subject: "a", text: "b" })), hints[2]);
    assert.equal(post.send(root, { from: "worker", to: "operator", subject: "a", text: "b", token: worker }).verified, "token");
  });

  t("without protected agents in the settings nothing is gated (the default)", () => {
    const root = fresh();
    const tree = path.join(root, "codex-tree");
    install(root, "operator", "assistant");
    post.register(root, { name: "codex-map", kind: "codex", folder: tree });
    assert.equal(post.send(root, { from: "codex-map", to: "operator", subject: "a", text: "b", folder: tree }).verified, "folder");
    assert.equal(post.openTask(root, { from: "codex-map", title: "Board", text: "x", folder: tree }).status, "open");
  });

  // --- No token on the command line -------------------------------------------------------------------------

  t("the command line rejects a token flag and does not echo it", () => {
    const root = fresh();
    const token = install(root, "operator", "assistant").token;
    const refused = h.run(root, path.join(root, "x"), ["verify", "--from", "operator", "--token", token]);
    assert.equal(refused.status, 1);
    assert.equal(code(refused), error("token_flag"));
    assert.ok(!refused.stderr.includes(token));
    assert.doesNotMatch(log(root), TOKEN);
  });
}
