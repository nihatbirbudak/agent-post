// Tests the post in every dialect: concurrent writers, corrupt and half lines, lock timeouts, the task and area lock flow, the secret filter, CLI, hook, MCP and sender verification (forged sender, wrong token, old message).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import * as post from "../src/agent-post.mjs";
import { CORE, DIALECT_NAMES, SCRIPT, cleanEnv, fake, harness } from "./helpers.mjs";

// Fake keys and tokens: only their shape looks real, and they are assembled at run time.
const SAMPLE = "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z";
const base64url = (text) => Buffer.from(text).toString("base64url");
const FAKE_JWT = [base64url('{"alg":"HS256","typ":"JWT"}'), base64url('{"iss":"example-token"}'), base64url("example-signature")].join(".");

function child(code, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { env: cleanEnv(env) });
    let errors = "";
    proc.stderr.on("data", (part) => (errors += part));
    proc.on("exit", (status) => (status === 0 ? resolve() : reject(new Error(errors))));
  });
}

/** Replaces one `fs` function during a test (the core uses the same `fs` object). */
function patchFs(name, replacement, work) {
  const original = fs[name];
  fs[name] = (...args) => replacement(original, ...args);
  try {
    return work();
  } finally {
    fs[name] = original;
  }
}

for (const dialect of DIALECT_NAMES) {
  const h = harness(dialect);
  const { d, key, value, error } = h;
  const t = (name, body) => test(`[${dialect}] ${name}`, body);

  t("two processes writing to the same inbox at once lose or mix no lines", async () => {
    const root = h.newRoot();
    const code = (from) => `
      import * as post from ${JSON.stringify(pathToFileURL(CORE).href)};
      for (let i = 0; i < 150; i++) {
        post.send(${JSON.stringify(root)}, { from: "${from}", to: "alice", subject: "${from} " + i, text: "x".repeat(200) });
      }`;
    await Promise.all([child(code("bob")), child(code("operator"))]);
    const records = h.lines(post.layout(root).inbox("alice")).map((line) => post.fromDisk(root, JSON.parse(line)));
    assert.equal(records.length, 300);
    assert.equal(new Set(records.map((r) => r.id)).size, 300);
    for (const from of ["bob", "operator"]) {
      const order = records.filter((r) => r.from === from).map((r) => Number(r.subject.split(" ")[1]));
      assert.deepEqual(order, [...Array(150).keys()]);
    }
    assert.equal(h.logEvents(root, "send").length, 300);
    assert.ok(post.agents(root).bob.last_seen);
  });

  t("a corrupt line is skipped and logged once; a half-written last line does not break the next record", () => {
    const root = h.newRoot();
    post.send(root, { from: "bob", to: "alice", subject: "first", text: "one" });
    const box = post.layout(root).inbox("alice");
    fs.appendFileSync(box, "corrupt line\n");
    fs.appendFileSync(box, '{"id":"m-half');
    post.send(root, { from: "bob", to: "alice", subject: "last", text: "two" });
    assert.deepEqual(post.inbox(root, "alice").map((m) => m.subject), ["first", "last"]);
    post.inbox(root, "alice");
    const corrupt = h.logEvents(root, "corrupt_line");
    assert.equal(corrupt.length, 1);
    assert.deepEqual(corrupt[0].lines, [2, 3]);
  });

  t("a crashed process's file lock is removed after the timeout; a live lock is waited for and times out", () => {
    const root = h.newRoot();
    const file = path.join(root, "trial.jsonl");
    const lockFile = `${file}${d.files.lockSuffix}`;
    fs.writeFileSync(lockFile, "{}");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, old, old);
    post.appendLine(root, file, { a: 1 });
    assert.equal(h.lines(file).length, 1);
    assert.ok(!fs.existsSync(lockFile));
    fs.writeFileSync(lockFile, "{}");
    assert.throws(() => post.withFileLock(root, file, () => 1, { wait: 200 }), { code: "lock_timeout" });
  });

  t("read marks persist and only unread messages return", () => {
    const root = h.newRoot();
    const { id } = post.send(root, { from: "bob", to: "alice", subject: "a", text: "b" });
    post.send(root, { from: "bob", to: "alice", subject: "c", text: "d" });
    assert.deepEqual(post.markRead(root, "alice", [id, id]), { marked: 1 });
    assert.deepEqual(post.inbox(root, "alice", { unread: true }).map((m) => m.subject), ["c"]);
    assert.equal(post.inbox(root, "alice").find((m) => m.id === id).read, true);
  });

  t("unknown agents, secrets and oversized text are rejected", () => {
    const root = h.newRoot();
    assert.throws(() => post.send(root, { from: "stranger", to: "bob", subject: "a", text: "b" }), { code: "unknown_agent" });
    assert.throws(() => post.send(root, { from: "bob", to: "nobody", subject: "a", text: "b" }), { code: "unknown_agent" });
    const secrets = [
      fake("key ", "sk-", "ant-", "api03-abcdefghijklmnop"),
      fake("token", ": abcdef123456"),
      fake("gh", "p_", "abcdefghijklmnopqrstuvwxyz12"),
      fake("password", " = example123"),
    ];
    for (const text of secrets) {
      assert.throws(() => post.send(root, { from: "bob", to: "alice", subject: "a", text }), { code: "secret_detected" });
    }
    assert.throws(() => post.send(root, { from: "bob", to: "alice", subject: "a", text: "x".repeat(70_000) }), { code: "too_large" });
    assert.throws(() => post.openTask(root, { from: "stranger", title: "a", text: "b" }), { code: "unknown_agent" });
    assert.ok(!fs.existsSync(post.layout(root).inbox("alice")));
  });

  t("a task opens, one agent claims it, the area lock stops a second, finishing releases it and the result goes to the opener", () => {
    const root = h.newRoot();
    const area = path.join(root, "projects", "shared");
    const task = post.openTask(root, { from: "operator", title: "Fix the document", text: "details", areas: [area], kind: "code" });
    assert.equal(task.status, "open");
    const second = post.openTask(root, { from: "operator", title: "Subfolder", text: "x", areas: [path.join(area, "sub")] });
    post.claimTask(root, task.id, "bob");
    assert.throws(() => post.claimTask(root, task.id, "alice"), { code: "task_not_claimable" });
    assert.throws(() => post.claimTask(root, second.id, "alice"), { code: "area_locked" });
    assert.equal(post.readTask(root, second.id).status, "open");
    assert.throws(() => post.finishTask(root, task.id, "alice", { status: "done", result: "x" }), { code: "task_not_finishable" });
    post.finishTask(root, task.id, "bob", { status: "done", result: "Fixed." });
    assert.deepEqual(post.locks(root), []);
    post.claimTask(root, second.id, "alice");
    const reply = post.inbox(root, "operator").find((m) => m.kind === "reply");
    assert.equal(reply.task_id, task.id);
    assert.equal(reply.text, "Fixed.");
    assert.deepEqual(post.tasks(root, { status: "done" }).map((x) => x.id), [task.id]);
  });

  t("a task opened for an agent does not pass to another, and a task message lands in that agent's inbox", () => {
    const root = h.newRoot();
    const task = post.openTask(root, { from: "operator", to: "bob", title: "For you", text: "work" });
    assert.throws(() => post.claimTask(root, task.id, "alice"), { code: "task_not_claimable" });
    assert.equal(post.inbox(root, "bob")[0].task_id, task.id);
  });

  t("an area lock whose owner has been silent for two hours counts as released and is logged", () => {
    const root = h.newRoot();
    const area = path.join(root, "projects", "shared");
    post.lock(root, "bob", [area]);
    assert.throws(() => post.lock(root, "alice", [area]), { code: "area_locked" });
    const old = post.now(new Date(Date.now() - post.AREA_SILENCE_MS - 60_000));
    const registryFile = post.layout(root).agents;
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    registry[key("agents")].bob[key("last_seen")] = old;
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    const locksDir = post.layout(root).locksDir;
    const lockFile = path.join(locksDir, fs.readdirSync(locksDir).find((name) => name.endsWith(".json")));
    fs.writeFileSync(lockFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(lockFile, "utf8")), [key("time")]: old }));
    assert.deepEqual(post.locks(root).map((l) => [l.owner, l.stale]), [["bob", true]]);
    post.lock(root, "alice", [area]);
    assert.deepEqual(post.locks(root).map((l) => [l.owner, l.stale]), [["alice", false]]);
    assert.equal(h.logEvents(root, "lock_expired").length, 1);
  });

  t("agent status and quota note are stored", () => {
    const root = h.newRoot();
    const agent = post.setStatus(root, "bob", { status: "quota_full", quota_note: "weekly limit" });
    assert.equal(agent.status, "quota_full");
    assert.equal(post.agents(root).bob.quota_note, "weekly limit");
    assert.throws(() => post.setStatus(root, "bob", { status: "sleeping" }), { code: "invalid_field" });
  });

  t("the hook finds the agent from the working folder and gives the unread summary; it stays silent elsewhere and on bad input", () => {
    const root = h.newRoot();
    const cwd = JSON.stringify({ cwd: path.join(root, "projects", "alice", "sub") });
    assert.equal(post.hook("UserPromptSubmit", cwd, root), "");
    post.send(root, { from: "bob", to: "alice", subject: "Hello", text: "x" });
    const text = post.hook("UserPromptSubmit", cwd, root);
    assert.ok(text.includes(d.text.summaryHead("alice", 1)), text);
    assert.match(text, /bob: Hello/);
    assert.ok(text.endsWith(d.text.summaryFoot(d.defaultApprover)));
    assert.equal(post.hook("UserPromptSubmit", `\uFEFF${JSON.stringify({ cwd: path.join(root, "projects", "alice") })}`, root), text);
    assert.equal(post.hook("UserPromptSubmit", JSON.stringify({ cwd: path.join(root, "elsewhere") }), root), "");
    assert.equal(post.hook("UserPromptSubmit", "{broken", root), "");
    assert.equal(post.hook("Stop", JSON.stringify({ cwd: path.join(root, "projects", "bob") }), root), "");
  });

  t("the CLI takes long text from a file and separates error codes", () => {
    const root = h.newRoot();
    const file = path.join(root, "text.txt");
    fs.writeFileSync(file, 'Quoted "long" text with ı ş ğ\nsecond line');
    const sent = h.run(root, root, ["send", "alice", "--from", "bob", "--subject", "From file", "--text-file", file]);
    assert.equal(sent.status, 0, sent.stderr);
    const read = h.run(root, root, ["inbox", "alice", "--unread", "--mark-read"]);
    assert.equal(read.json()[0].text, 'Quoted "long" text with ı ş ğ\nsecond line');
    assert.deepEqual(h.run(root, root, ["inbox", "alice", "--unread"]).json(), []);
    const unknown = h.run(root, root, ["send", "bob", "--from", "nobody", "--subject", "a", "--text", "b"]);
    assert.equal(unknown.status, 1);
    assert.ok(unknown.stderr.startsWith(`${error("unknown_agent")}: `));
    assert.equal(h.run(root, root, ["no-such-command"]).status, 2);
    const hooked = h.run(root, root, ["hook", "UserPromptSubmit"], { input: "{broken" });
    assert.equal(hooked.status, 0);
    assert.equal(hooked.stdout, "");
  });

  t("the secret filter catches Turkish labels, newer key formats, JWT and Bearer; it leaves ordinary text alone", () => {
    const root = h.newRoot();
    const caught = [
      fake("şifre", ": example-1234"),
      fake("Şifre", " = example-1234"),
      fake("ŞİFRE", ": example-1234"),
      fake("wifi şifresi", ": example-1234"),
      fake("MQTT_PAROLA", "=example-1234"),
      fake('"pass', 'word": "example-1234"'),
      fake("sk-", "proj-", SAMPLE),
      fake("sk_", "a1b2c3d4".repeat(6)),
      fake("github_", "pat_11ABCDEFG0_", SAMPLE),
      FAKE_JWT,
      fake("aws_secret_access_key = ", "q8Zr2Lm7Xv4Tn1Bw6Ks9", "Hd3Fp0Gy5Jc/Ue+Ra2Vb"),
      fake("Authorization: Bearer ", SAMPLE),
      fake("mqtt://user", ":example-pass@", "192.0.2.10:1883"),
    ];
    for (const text of caught) {
      assert.throws(() => post.send(root, { from: "bob", to: "alice", subject: "a", text }), { code: "secret_detected" }, text);
    }
    assert.throws(() => post.send(root, { from: "bob", to: "alice", subject: fake("şifre", ": example-1234"), text: "x" }), {
      code: "secret_detected",
    });
    const ordinary = [
      "Bu kaydı deşifre: edip özetle",
      "task-runner-for-the-greenhouse-system is ready",
      "Bearer token needs renewing; check whether the password changed",
      "C:\\Users\\alice\\projects\\demo has 12 changed files",
      "Task t-mh4abcde-1a2b3c is done: no string starting with eyJ",
    ];
    for (const text of ordinary) post.send(root, { from: "bob", to: "alice", subject: "a", text });
    assert.equal(post.inbox(root, "alice").length, ordinary.length);
  });

  t("the quota note and the account label pass the secret filter too", () => {
    const root = h.newRoot();
    assert.throws(() => post.setStatus(root, "bob", { status: "quota_full", quota_note: fake("key ", "sk-", "proj-", SAMPLE) }), {
      code: "secret_detected",
    });
    assert.equal(post.agents(root).bob.status, "idle");
    assert.throws(() => post.register(root, { name: "new-agent", kind: "api", account: fake("token", ": ", SAMPLE) }), {
      code: "secret_detected",
    });
    assert.equal(post.agents(root)["new-agent"], undefined);
    assert.equal(post.setStatus(root, "bob", { status: "quota_full", quota_note: "weekly limit 100%" }).quota_note, "weekly limit 100%");
  });

  t("register changes a registered agent's folder only explicitly and with authority; a new agent gets the session folder and a token", () => {
    const root = h.newRoot();
    const registered = post.agents(root).bob.folder;
    const state = { me: null, folder: path.join(root, "other-session") };
    const reg = (args, s = state) => h.mcp(root, s, "register", args);
    assert.equal(reg({ name: "bob", kind: "codex" }).error, undefined);
    assert.equal(post.agents(root).bob.folder, registered);
    post.register(root, { name: "bob", kind: "codex", account: "codex-2" });
    assert.equal(post.agents(root).bob.folder, registered);
    const newAgent = reg({ name: "new-agent", kind: "claude" });
    assert.equal(post.agents(root)["new-agent"].folder, path.resolve(state.folder));
    assert.match(newAgent.token, new RegExp(`^${d.tokenPrefix}[A-Za-z0-9_-]{32}$`));
    // no folder binding elsewhere or from someone else's place
    const elsewhere = path.join(root, "projects", "new-place");
    assert.ok(reg({ name: "bob", kind: "codex", folder: elsewhere }).error.startsWith(error("identity_mismatch")));
    assert.ok(reg({ name: "bob", kind: "codex", folder: state.folder }).error.startsWith(error("identity_mismatch")));
    assert.equal(post.agents(root).bob.folder, registered);
    // an agent can move from inside its folder and renew its token; with the token it can move from elsewhere
    const inside = { me: null, folder: path.join(registered, "sub") };
    assert.equal(reg({ name: "bob", kind: "codex", folder: inside.folder }, inside).error, undefined);
    const { token } = reg({ name: "bob", kind: "codex", new_token: true }, inside);
    assert.ok(token.startsWith(d.tokenPrefix));
    assert.equal(reg({ name: "bob", kind: "codex", folder: state.folder, token }).error, undefined);
    assert.equal(post.agents(root).bob.folder, path.resolve(state.folder));
    assert.equal(h.logEvents(root, "identity_mismatch").length, 2);
  });

  // --- Sender verification: hostile cases -------------------------------------------------------------------

  t("--from alice from another agent's folder is rejected (identity_mismatch, logged); from its own folder it is verified by folder", () => {
    const root = h.newRoot();
    const forged = h.run(root, path.join(root, "projects", "bob"), ["send", "operator", "--from", "alice", "--subject", "Manager reply", "--text", "Ship it"]);
    assert.equal(forged.status, 1);
    assert.ok(forged.stderr.startsWith(`${error("identity_mismatch")}: ${d.text.folderBelongs(["bob"], "alice")}`), forged.stderr);
    assert.ok(!fs.existsSync(post.layout(root).inbox("operator")));
    const [mismatch] = h.logEvents(root, "identity_mismatch");
    assert.deepEqual([mismatch.agent, mismatch.operation, mismatch.candidates], ["alice", "send", ["bob"]]);
    const real = h.run(root, path.join(root, "projects", "alice", "sub"), ["send", "operator", "--from", "alice", "--subject", "Reply", "--text", "ok"]);
    assert.equal(real.status, 0, real.stderr);
    const [message] = post.inbox(root, "operator");
    assert.deepEqual([message.from, message.verified], ["alice", "folder"]);
    // MCP: a session in another agent's folder cannot register as that agent; its identity does not change
    const state = { me: null, folder: path.join(root, "projects", "bob") };
    assert.ok(h.mcp(root, state, "register", { name: "alice", kind: "claude" }).error.startsWith(error("identity_mismatch")));
    assert.equal(state.me, null);
    h.mcp(root, state, "send", { to: "operator", subject: "note", text: "x" });
    assert.deepEqual(post.inbox(root, "operator").map((m) => [m.from, m.verified]), [["alice", "folder"], ["bob", "folder"]]);
  });

  t("agent without a folder: none and a log entry in warn mode; strict mode needs a token; a wrong token is rejected in every mode", () => {
    const root = h.newRoot();
    const message = { from: "operator", to: "bob", subject: "a", text: "b" };
    post.send(root, message);
    assert.equal(post.inbox(root, "bob").at(-1).verified, "none");
    assert.deepEqual(h.logEvents(root, "identity_unverified").map((o) => [o.agent, o.operation]), [["operator", "send"]]);
    // warn mode, from another agent's folder as the folderless agent: passes as none, candidates logged
    post.send(root, { ...message, folder: path.join(root, "projects", "alice") });
    assert.deepEqual(h.logEvents(root, "identity_unverified").at(-1).candidates, ["alice"]);
    const token = post.issueToken(root, "operator");
    const wrong = `${d.tokenPrefix}wrong`;
    assert.throws(() => post.send(root, { ...message, token: wrong }), { code: "invalid_token" });
    assert.throws(() => post.send(root, { ...message, token: post.issueToken(root, "bob") }), { code: "invalid_token" });
    post.setTokenMode(root, "strict");
    assert.equal(post.tokenMode(root), "strict");
    assert.throws(() => post.send(root, message), { code: "token_required" });
    assert.throws(() => post.send(root, { ...message, folder: path.join(root, "projects", "alice") }), { code: "identity_mismatch" });
    assert.throws(() => post.openTask(root, { from: "operator", title: "x", text: "y" }), { code: "token_required" });
    post.send(root, { ...message, token });
    assert.equal(post.inbox(root, "bob").at(-1).verified, "token");
    // command line: token from the environment, wrong --token rejected, --token without a value
    const place = path.join(root, "elsewhere");
    const args = ["send", "bob", "--from", "operator", "--subject", "a", "--text", "b"];
    assert.equal(h.run(root, place, args).status, 1);
    const withEnv = h.run(root, place, args, { token });
    assert.equal(withEnv.status, 0, withEnv.stderr);
    assert.ok(h.run(root, place, [...args, "--token", wrong]).stderr.startsWith(error("invalid_token")));
    assert.ok(h.run(root, place, [...args, "--token"]).stderr.startsWith(error("missing_argument")));
    // strict mode: an agent bound to a folder writes from it without a token
    post.send(root, { from: "bob", to: "operator", subject: "a", text: "b", folder: path.join(root, "projects", "bob") });
    assert.equal(post.inbox(root, "operator").at(-1).verified, "folder");
  });

  t("an old message (no verification field) and an unknown verification value read as none", () => {
    const root = h.newRoot();
    const box = post.layout(root).inbox("operator");
    fs.mkdirSync(path.dirname(box), { recursive: true });
    const old = {
      id: "m-mh0000001-aaaaaa",
      time: "2026-10-30T10:00:00+03:00",
      from: "alice",
      to: "operator",
      kind: "reply",
      subject: "old",
      text: "x",
      attachments: [],
      reply_to: null,
      task_id: null,
    };
    const rows = [old, { ...old, id: "m-mh0000002-bbbbbb", verified: "signed" }].map((row) => JSON.stringify(post.toDisk(root, row)));
    fs.writeFileSync(box, `${rows.join("\n")}\n`);
    assert.deepEqual(post.inbox(root, "operator").map((m) => m.verified), ["none", "none"]);
  });

  t("a token is stored only as its SHA-256 digest, is not shown in the agent list and cannot be written into post text", () => {
    const root = h.newRoot();
    const { token, has_token } = post.register(root, { name: "worker", kind: "api" });
    assert.equal(has_token, true);
    const raw = fs.readFileSync(post.layout(root).agents, "utf8");
    assert.ok(!raw.includes(token));
    assert.equal(JSON.parse(raw)[key("agents")].worker[key("token_digest")], crypto.createHash("sha256").update(token).digest("hex"));
    const list = post.agentList(root);
    assert.equal(list.worker.token_digest, undefined);
    assert.equal(list.worker.has_token, true);
    assert.equal(h.run(root, root, ["agents"]).stdout.includes(key("token_digest")), false);
    assert.throws(() => post.send(root, { from: "worker", to: "bob", subject: "a", text: `token ${token}`, token }), { code: "secret_detected" });
    assert.ok(!h.logEvents(root, "register").some((o) => JSON.stringify(o).includes(token)));
  });

  t("opening and finishing tasks pass sender verification; the task and the result message carry it", () => {
    const root = h.newRoot();
    const aliceFolder = path.join(root, "projects", "alice");
    const bobFolder = path.join(root, "projects", "bob");
    const task = post.openTask(root, { from: "alice", to: "bob", title: "Job", text: "x", folder: aliceFolder });
    assert.equal(task.verified, "folder");
    assert.equal(post.inbox(root, "bob")[0].verified, "folder");
    assert.throws(() => post.openTask(root, { from: "alice", title: "Forged", text: "x", folder: bobFolder }), { code: "identity_mismatch" });
    assert.equal(post.tasks(root).length, 1);
    post.claimTask(root, task.id, "bob");
    assert.throws(() => post.finishTask(root, task.id, "bob", { status: "done", result: "x", folder: aliceFolder }), { code: "identity_mismatch" });
    assert.equal(post.readTask(root, task.id).status, "claimed");
    post.finishTask(root, task.id, "bob", { status: "done", result: "Done.", folder: bobFolder });
    const reply = post.inbox(root, "alice").find((m) => m.task_id === task.id);
    assert.deepEqual([reply.kind, reply.verified], ["reply", "folder"]);
  });

  t("agents registered to the same folder are verified from it; a deeper registered folder excludes the parent's agent", () => {
    const root = h.newRoot();
    const aliceFolder = path.join(root, "projects", "alice");
    post.register(root, { name: "carol", kind: "claude", folder: aliceFolder });
    assert.deepEqual(post.folderCandidates(root, path.join(aliceFolder, "worktree")), ["alice", "carol"]);
    assert.equal(post.folderAgent(root, path.join(aliceFolder, "worktree")), "alice");
    post.send(root, { from: "carol", to: "operator", subject: "a", text: "b", folder: path.join(aliceFolder, "worktree") });
    assert.equal(post.inbox(root, "operator")[0].verified, "folder");
    const state = { me: null, folder: aliceFolder };
    assert.equal(h.mcp(root, state, "register", { name: "carol", kind: "claude" }).error, undefined);
    assert.equal(state.me, "carol");
    post.register(root, { name: "deep-agent", kind: "claude", folder: path.join(aliceFolder, "deep") });
    assert.throws(
      () => post.send(root, { from: "alice", to: "operator", subject: "a", text: "b", folder: path.join(aliceFolder, "deep", "x") }),
      { code: "identity_mismatch" },
    );
  });

  t("MCP: the start identity's token verifies sending and survives re-registering the same identity; it does not pass to another", () => {
    const root = h.newRoot();
    const token = post.issueToken(root, "operator");
    const state = { me: "operator", folder: path.join(root, "elsewhere"), token };
    h.mcp(root, state, "send", { to: "bob", subject: "a", text: "b" });
    assert.equal(h.mcp(root, state, "register", { name: "operator", kind: "assistant" }).error, undefined);
    assert.equal(state.token, token);
    h.mcp(root, state, "send", { to: "bob", subject: "c", text: "d" });
    assert.deepEqual(post.inbox(root, "bob").map((m) => m.verified), ["token", "token"]);
    // registering as another identity does not carry the old token (passes unverified in warn mode)
    h.mcp(root, state, "register", { name: "worker", kind: "api" });
    assert.equal(state.me, "worker");
    assert.notEqual(state.token, token);
    assert.ok(h.mcp(root, { ...state, me: "bob" }, "send", { to: "operator", subject: "a", text: "b", token }).error.startsWith(error("invalid_token")));
  });

  t("if finishing a task stops while releasing locks, the same agent's retry releases them and sends the result once", () => {
    const root = h.newRoot();
    const area = path.join(root, "projects", "shared");
    const task = post.openTask(root, { from: "operator", title: "Half done", text: "x", areas: [area] });
    post.claimTask(root, task.id, "bob");
    const locksName = path.basename(post.layout(root).locksDir);
    let failure = true;
    const readdir = (original, dirPath, ...rest) => {
      if (failure && path.basename(String(dirPath)) === locksName) {
        failure = false;
        throw Object.assign(new Error("EIO: fake disk error"), { code: "EIO" });
      }
      return original(dirPath, ...rest);
    };
    assert.throws(() => patchFs("readdirSync", readdir, () => post.finishTask(root, task.id, "bob", { status: "done", result: "Done." })), /EIO/);
    assert.equal(post.readTask(root, task.id).status, "done");
    assert.equal(post.locks(root).length, 1);
    const replies = () => post.inbox(root, "operator").filter((m) => m.kind === "reply" && m.task_id === task.id);
    // the agent's progress note linked to the task is not the result
    post.send(root, { from: "bob", to: "operator", kind: "reply", subject: "progress", text: "half way", task_id: task.id });
    assert.throws(() => post.finishTask(root, task.id, "bob", { status: "blocked", result: "other text" }), { code: "task_not_finishable" });
    const again = post.finishTask(root, task.id, "bob", { status: "done", result: "Done." });
    assert.deepEqual([again.status, again.result], ["done", "Done."]);
    assert.deepEqual(post.locks(root), []);
    assert.deepEqual(replies().map((m) => [m.subject, m.text]), [["progress", "half way"], [`${value("done")}: Half done`, "Done."]]);
    post.finishTask(root, task.id, "bob", { status: "done", result: "Done." });
    assert.equal(replies().length, 2);
    assert.equal(post.readTask(root, task.id).history.filter((x) => x.event === "done").length, 1);
    assert.throws(() => post.finishTask(root, task.id, "alice", { status: "done", result: "x" }), { code: "task_not_finishable" });
  });

  t("a task awaiting approval closes as done or blocked after approval and the new result goes to the opener; a finished task's result does not change", () => {
    const root = h.newRoot();
    const task = post.openTask(root, { from: "operator", title: "Publish", text: "x" });
    post.claimTask(root, task.id, "bob");
    post.finishTask(root, task.id, "bob", { status: "awaiting_approval", result: "Needs approval." });
    assert.throws(() => post.finishTask(root, task.id, "bob", { status: "awaiting_approval", result: "Another request." }), {
      code: "task_not_finishable",
    });
    assert.throws(() => post.finishTask(root, task.id, "alice", { status: "done", result: "x" }), { code: "task_not_finishable" });
    const finished = post.finishTask(root, task.id, "bob", { status: "done", result: "Published." });
    assert.deepEqual([finished.status, finished.result], ["done", "Published."]);
    assert.deepEqual(finished.history.map((x) => x.event), ["opened", "claimed", "awaiting_approval", "done"]);
    const results = post.inbox(root, "operator").filter((m) => m.task_id === task.id).map((m) => [m.subject, m.text]);
    assert.deepEqual(results, [
      [`${value("awaiting_approval")}: Publish`, "Needs approval."],
      [`${value("done")}: Publish`, "Published."],
    ]);
    assert.throws(() => post.finishTask(root, task.id, "bob", { status: "blocked", result: "Undo." }), { code: "task_not_finishable" });
    assert.equal(post.readTask(root, task.id).status, "done");
  });

  t("a task whose title fills the limit with multi-byte letters still reports its result (the subject is cut at the byte limit)", () => {
    const root = h.newRoot();
    const title = "ğ".repeat(100);
    assert.equal(Buffer.byteLength(title), 200);
    const task = post.openTask(root, { from: "operator", title, text: "x" });
    post.claimTask(root, task.id, "bob");
    post.finishTask(root, task.id, "bob", { status: "awaiting_approval", result: "Approval needed." });
    const reply = post.inbox(root, "operator").find((m) => m.task_id === task.id);
    assert.ok(Buffer.byteLength(reply.subject) <= 200);
    assert.ok(reply.subject.startsWith(`${value("awaiting_approval")}: ğğ`));
  });

  t("a retry by the agent that claimed a task returns the same task; if the task cannot be written, the locks taken are released", () => {
    const root = h.newRoot();
    const area = path.join(root, "projects", "shared");
    const task = post.openTask(root, { from: "operator", title: "Claim", text: "x", areas: [area] });
    const rename = (original, from, to) => {
      if (path.basename(String(to)) === `${task.id}.json`) throw Object.assign(new Error("EIO: fake disk error"), { code: "EIO" });
      return original(from, to);
    };
    assert.throws(() => patchFs("renameSync", rename, () => post.claimTask(root, task.id, "bob")), /EIO/);
    assert.equal(post.readTask(root, task.id).status, "open");
    assert.deepEqual(post.locks(root), []);
    post.claimTask(root, task.id, "bob");
    const again = post.claimTask(root, task.id, "bob");
    assert.deepEqual([again.status, again.claimed_by], ["claimed", "bob"]);
    assert.equal(again.history.filter((x) => x.event === "claimed").length, 1);
    assert.deepEqual(post.locks(root).map((l) => [l.owner, l.task]), [["bob", task.id]]);
    assert.throws(() => post.claimTask(root, task.id, "alice"), { code: "task_not_claimable" });
  });

  t("a file lock is removed only if its token matches: a lock that passed to someone else stays when the old owner exits", () => {
    const root = h.newRoot();
    const file = path.join(root, "trial.json");
    const lockFile = `${file}${d.files.lockSuffix}`;
    const someoneElse = JSON.stringify({ pid: 0, time: Date.now(), token: "other-process" });
    post.withFileLock(root, file, () => fs.writeFileSync(lockFile, someoneElse));
    assert.equal(fs.readFileSync(lockFile, "utf8"), someoneElse);
  });

  t("if a fresh lock replaces a stale one right after it was judged stale, the fresh lock is not removed and stays with its owner", () => {
    const root = h.newRoot();
    const file = path.join(root, "race.json");
    const lockFile = `${file}${d.files.lockSuffix}`;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 0, time: 0, token: "dead-process" }));
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, old, old);
    const fresh = JSON.stringify({ pid: 0, time: Date.now(), token: "fresh-process" });
    let between = true;
    const stat = (original, target, ...rest) => {
      const result = original(target, ...rest);
      if (between && target === lockFile) {
        // another process removed the stale lock, a third took a fresh one
        between = false;
        fs.rmSync(lockFile);
        fs.writeFileSync(lockFile, fresh);
      }
      return result;
    };
    assert.throws(() => patchFs("statSync", stat, () => post.withFileLock(root, file, () => 1, { wait: 300 })), { code: "lock_timeout" });
    assert.equal(fs.readFileSync(lockFile, "utf8"), fresh);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith(`race.json${d.files.lockSuffix}.`)), []);
  });

  t("the cleanup lock of a process that crashed while removing a stale lock is removed after its timeout too", () => {
    const root = h.newRoot();
    const file = path.join(root, "cleanup.json");
    const old = new Date(Date.now() - 120_000);
    for (const name of [`${file}${d.files.lockSuffix}`, `${file}${d.files.lockSuffix}${d.files.cleanupSuffix}`]) {
      fs.writeFileSync(name, "{}");
      fs.utimesSync(name, old, old);
    }
    assert.equal(post.withFileLock(root, file, () => 7, { wait: 2_000 }), 7);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith("cleanup.json")), []);
  });

  t("MCP send links the task id to the message", () => {
    const root = h.newRoot();
    const task = post.openTask(root, { from: "operator", title: "Linked", text: "work" });
    const state = { me: "bob", folder: null };
    assert.equal(h.mcp(root, state, "send", { to: "operator", subject: "note", text: "half way", task_id: task.id }).error, undefined);
    assert.equal(post.inbox(root, "operator")[0].task_id, task.id);
    assert.ok(h.mcp(root, state, "send", { to: "operator", subject: "note", text: "x", task_id: "m-abcdefgh-123456" }).error.startsWith(error("invalid_field")));
  });

  t("CLI send links the task id to the message; a value that is not a task id is rejected", () => {
    const root = h.newRoot();
    const task = post.openTask(root, { from: "operator", title: "To route", text: "work" });
    const run = (...extra) => h.run(root, root, ["send", "bob", "--from", "operator", "--subject", "Task", "--text", "take", "--kind", "task", ...extra]);
    const sent = run("--task-id", task.id);
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(post.inbox(root, "bob")[0].task_id, task.id);
    for (const extra of [["--task-id", "m-abcdefgh-123456"], ["--task-id"]]) {
      const rejected = run(...extra);
      assert.equal(rejected.status, 1);
      assert.ok(rejected.stderr.startsWith(error("invalid_field")), rejected.stderr);
    }
    assert.equal(post.inbox(root, "bob").length, 1);
  });

  t("the MCP server starts, lists tools, finds the identity from the folder and returns tool errors with isError", async () => {
    const root = h.newRoot();
    const folder = path.join(root, "projects", "alice");
    fs.mkdirSync(folder, { recursive: true });
    const proc = spawn(process.execPath, [SCRIPT, "mcp"], { cwd: folder, env: cleanEnv({ [d.env.root]: root }) });
    const responses = [];
    let buffer = "";
    proc.stdout.on("data", (part) => {
      buffer += part;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      responses.push(...parts.filter(Boolean).map((line) => JSON.parse(line)));
    });
    const write = (data) => proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...data })}\n`);
    const call = (id, args) => write({ id, method: "tools/call", params: { name: h.tool("send"), arguments: post.toDisk(root, args) } });
    write({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "trial", version: "0" } } });
    write({ method: "notifications/initialized" });
    write({ id: 2, method: "tools/list" });
    call(3, { to: "bob", subject: "From MCP", text: "hi" });
    call(4, { to: "bob", subject: "s", text: fake("token", ": abcdef123456") });
    write({ id: 5, method: "unknown" });
    const deadline = Date.now() + 10_000;
    while (responses.length < 5 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    proc.kill();
    const find = (id) => responses.find((r) => r.id === id);
    assert.equal(find(1).result.serverInfo.name, d.server.name);
    assert.ok(find(2).result.tools.some((x) => x.name === h.tool("task_claim")));
    assert.ok(!find(3).result.isError, JSON.stringify(find(3)));
    assert.equal(find(4).result.isError, true);
    assert.ok(find(4).result.content[0].text.startsWith(error("secret_detected")));
    assert.equal(find(5).error.code, -32601);
    const [message] = post.inbox(root, "bob");
    assert.deepEqual([message.from, message.verified], ["alice", "folder"]);
  });

  t("the verify query reports verification and mode without logging; send returns the verification", () => {
    const root = h.newRoot();
    const place = path.join(root, "operator-root");
    const query = (token) => h.run(root, place, ["verify", "--from", "operator"], { token });
    const logSize = () => fs.readFileSync(post.layout(root).log, "utf8").length;
    const before = logSize();
    assert.deepEqual(query().json(), { agent: "operator", verified: "none", mode: "warn" });
    const token = post.issueToken(root, "operator");
    const after = logSize();
    assert.equal(query(token).json().verified, "token");
    post.setTokenMode(root, "strict");
    const rejected = query();
    assert.equal(rejected.status, 1);
    assert.ok(rejected.stderr.startsWith(error("token_required")));
    assert.ok(query(`${d.tokenPrefix}wrong`).stderr.startsWith(error("invalid_token")));
    // only issuing the token and writing the mode reached the log; the queries did not
    const events = fs
      .readFileSync(post.layout(root).log, "utf8")
      .slice(before)
      .split("\n")
      .filter(Boolean)
      .map((line) => post.fromDisk(root, JSON.parse(line)).event);
    assert.deepEqual(events, ["token_issue", "token_mode"]);
    assert.ok(after > before);
    assert.ok(!fs.readFileSync(post.layout(root).log, "utf8").includes(token));
    assert.equal(post.send(root, { from: "operator", to: "bob", subject: "a", text: "b", token }).verified, "token");
  });
}
