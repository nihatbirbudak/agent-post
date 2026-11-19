// Tests durable writes in every dialect: data reaches the disk before a rename, the registry keeps a backup and falls back to it only when its content is corrupt, the fallback is never silent (log, MCP, CLI and prompt hook warning, shared between processes for a while), and a NUL-filled JSONL tail is not a line.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as post from "../src/agent-post.mjs";
import { DIALECT_NAMES, SCRIPT, cleanEnv, harness } from "./helpers.mjs";

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

const WARNING = {
  en: { mcp: /^warning: agents\.json is corrupt; the registry was read from its backup, which is /, hook: /agent-post warning: agents\.json is corrupt/ },
  "tr-v1": { mcp: /^uyari: ajanlar\.json bozuk; kayıt yedekten okundu, yedeğin yaşı /, hook: /Ajan postası uyarısı: ajanlar\.json bozuk/ },
};

test("an atomic write forces the temporary file to disk before it takes the target's name", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-fsync-"));
  const file = path.join(folder, "x.json");
  const order = [];
  patchFs(
    "fsyncSync",
    (original, fd) => {
      order.push("fsync");
      return original(fd);
    },
    () =>
      patchFs(
        "renameSync",
        (original, from, to) => {
          order.push(`rename:${path.basename(to)}`);
          return original(from, to);
        },
        () => post.atomicWrite(file, '{"a": 1}\n'),
      ),
  );
  assert.deepEqual(order, ["fsync", "rename:x.json"]);
  assert.equal(fs.readFileSync(file, "utf8"), '{"a": 1}\n');
  assert.deepEqual(fs.readdirSync(folder), ["x.json"]);
});

test("a JSONL file whose tail is all NUL bytes: sound lines are read, the NUL block is no corrupt line, a new append is read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-nul-"));
  const file = path.join(root, "x.jsonl");
  fs.writeFileSync(file, Buffer.concat([Buffer.from('{"a":1}\n{"a":2}\n'), Buffer.alloc(169)]));
  assert.deepEqual(post.readLines(root, file).map((r) => r.a), [1, 2]);
  post.appendLine(root, file, { a: 3 });
  assert.deepEqual(post.readLines(root, file).map((r) => r.a), [1, 2, 3]);
  assert.ok(!fs.existsSync(post.layout(root).corrupt));
});

for (const dialect of DIALECT_NAMES) {
  const h = harness(dialect);
  const { error } = h;
  const t = (name, body) => test(`[${dialect}] ${name}`, body);
  const call = (root, id) =>
    post.mcpHandle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: h.tool("agents"), arguments: {} } }, { me: null, folder: root }, root);
  const hookRun = (root, eventName, cwd) =>
    spawnSync(process.execPath, [SCRIPT, h.command("hook"), eventName], {
      input: JSON.stringify({ cwd }),
      env: cleanEnv({ [h.d.env.root]: root }),
      encoding: "utf8",
    });
  const zeroFill = (file) => fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));

  t("every registry write leaves a backup, main file first", () => {
    const root = h.newRoot();
    const { agents } = post.layout(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(post.layout(root).agentsBackup, "utf8")), JSON.parse(fs.readFileSync(agents, "utf8")));
    const order = [];
    patchFs(
      "renameSync",
      (original, from, to) => {
        order.push(path.basename(to));
        return original(from, to);
      },
      () => post.touch(root, "alice"),
    );
    assert.deepEqual(order, [path.basename(agents), path.basename(post.layout(root).agentsBackup)]);
  });

  t("an all-zero registry is read from its backup, logged once, and the next registry write repairs it", () => {
    const root = h.newRoot();
    const { agents } = post.layout(root);
    zeroFill(agents);
    assert.deepEqual(Object.keys(post.agents(root)).sort(), ["alice", "bob", "operator"]);
    assert.deepEqual(Object.keys(post.agents(root)).sort(), ["alice", "bob", "operator"]);
    assert.deepEqual(h.logEvents(root, "corrupt_file_from_backup").map((e) => e.file), [path.basename(agents)]);
    post.touch(root, "bob");
    assert.equal(post.fromDisk(root, JSON.parse(fs.readFileSync(agents, "utf8"))).agents.bob.name, "bob");
    post.takeBackupWarning();
  });

  t("if the registry and its backup are both corrupt, the visible error stays", () => {
    const root = h.newRoot();
    const { agents, agentsBackup } = post.layout(root);
    fs.writeFileSync(agents, Buffer.alloc(100));
    fs.writeFileSync(agentsBackup, Buffer.alloc(100));
    assert.throws(() => post.agents(root), { code: "corrupt_file" });
    fs.rmSync(agentsBackup);
    assert.throws(() => post.agents(root), { code: "corrupt_file" });
    assert.equal(h.logEvents(root, "corrupt_file_from_backup").length, 0);
  });

  t("valid JSON in the wrong shape is a corrupt registry, in the main file and in the backup", () => {
    for (const content of ["null", "[]", "7", "{}", `{"${h.key("agents")}": []}`]) {
      const root = h.newRoot();
      const { agents, agentsBackup } = post.layout(root);
      fs.writeFileSync(agents, Buffer.alloc(64));
      fs.writeFileSync(agentsBackup, content);
      assert.throws(() => post.agents(root), { code: "corrupt_file" }, content);
      fs.writeFileSync(agents, content);
      fs.rmSync(agentsBackup);
      assert.throws(() => post.agents(root), { code: "corrupt_file" }, `main ${content}`);
    }
  });

  t("a read error on a sound registry does not fall back to the backup: visible error, no data changes", () => {
    const root = h.newRoot();
    const { agents, agentsBackup } = post.layout(root);
    post.register(root, { name: "newcomer", kind: "api" });
    const older = JSON.parse(fs.readFileSync(agents, "utf8"));
    delete older[h.key("agents")].newcomer;
    fs.writeFileSync(agentsBackup, JSON.stringify(older));
    const before = fs.readFileSync(agents);
    patchFs(
      "readFileSync",
      (original, file, ...rest) => {
        if (path.resolve(String(file)) === path.resolve(agents)) {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return original(file, ...rest);
      },
      () => assert.throws(() => post.touch(root, "bob"), (e) => e.code === "corrupt_file" && /EBUSY/.test(e.message)),
    );
    assert.deepEqual(fs.readFileSync(agents), before);
    assert.equal(post.agents(root).newcomer.name, "newcomer");
    assert.equal(h.logEvents(root, "corrupt_file_from_backup").length, 0);
  });

  t("a failed backup write returns the main write's result, keeps the token and logs backup_not_written", () => {
    const root = h.newRoot();
    const { agents, agentsBackup } = post.layout(root);
    fs.rmSync(agentsBackup);
    fs.mkdirSync(path.join(agentsBackup, "blocker"), { recursive: true });
    const result = post.register(root, { name: "newcomer", kind: "api" });
    assert.match(result.token, new RegExp(`^${h.d.tokenPrefix}`));
    assert.equal(JSON.parse(fs.readFileSync(agents, "utf8"))[h.key("agents")].newcomer[h.key("name")], "newcomer");
    assert.equal(h.logEvents(root, "backup_not_written").length, 1);
    assert.ok(!fs.readdirSync(root).some((name) => name.endsWith(".tmp")));
  });

  t("an older backup is never read silently: both times and the age in the log, a warning in MCP and in the CLI", () => {
    const root = h.newRoot();
    const { agents, agentsBackup } = post.layout(root);
    post.takeBackupWarning();
    post.register(root, { name: "newcomer", kind: "api" });
    const older = JSON.parse(fs.readFileSync(agents, "utf8"));
    delete older[h.key("agents")].newcomer;
    fs.writeFileSync(agentsBackup, JSON.stringify(older));
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(agentsBackup, hourAgo, hourAgo);
    zeroFill(agents);
    const first = call(root, 1).result;
    assert.equal(first.content.length, 2);
    assert.match(first.content[1].text, WARNING[dialect].mcp);
    assert.match(first.content[1].text, dialect === "en" ? /(59|60|61) min old and older than the main file/ : /(59|60|61) dk ve asıl dosyadan eski/);
    const [entry] = h.logEvents(root, "corrupt_file_from_backup");
    assert.equal(entry.backup_stale, true);
    assert.ok(entry.backup_age_s >= 3590 && entry.main_time && entry.backup_time, JSON.stringify(entry));
    // the same process does not warn twice; another process (CLI) warns on its own first call
    assert.equal(call(root, 2).result.content.length, 1);
    const cli = h.run(root, path.join(root, "elsewhere"), ["agents"]);
    assert.equal(cli.status, 0);
    assert.match(cli.stderr, WARNING[dialect].mcp);
    // on a rejected call the rejection stays the first line, the warning follows
    const rejected = h.run(root, path.join(root, "elsewhere"), ["send", "bob", "--from", "nobody", "--subject", "a", "--text", "b"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`^${error("unknown_agent")}: .*\\n${WARNING[dialect].mcp.source.slice(1)}`));
  });

  t("the Stop hook does not use up the warning: it repairs the registry, the next prompt still warns", () => {
    const root = h.newRoot();
    const { agents } = post.layout(root);
    const folder = path.join(root, "projects", "alice");
    fs.mkdirSync(folder, { recursive: true });
    zeroFill(agents);
    const stop = hookRun(root, "Stop", folder);
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, "");
    assert.equal(post.fromDisk(root, JSON.parse(fs.readFileSync(agents, "utf8"))).agents.alice.name, "alice");
    assert.match(hookRun(root, "UserPromptSubmit", folder).stdout, WARNING[dialect].hook);
    // within its lifetime the copy stays: every new process shows it once
    assert.match(hookRun(root, "UserPromptSubmit", folder).stdout, WARNING[dialect].hook);
    assert.ok(fs.existsSync(post.layout(root).backupWarning));
    assert.equal(h.logEvents(root, "corrupt_file_from_backup").length, 1);
  });

  /** A root whose registry was zero-filled and then repaired by a Stop hook (which wrote the shared copy). */
  function stoppedRoot() {
    const root = h.newRoot();
    const folder = path.join(root, "projects", "alice");
    fs.mkdirSync(folder, { recursive: true });
    zeroFill(post.layout(root).agents);
    assert.equal(hookRun(root, "Stop", folder).stdout, "");
    assert.ok(fs.existsSync(post.layout(root).backupWarning));
    return { root, folder };
  }

  t("repeated CLI polls show the warning but do not use it up for the next prompt", () => {
    const { root, folder } = stoppedRoot();
    for (let i = 0; i < 3; i++) {
      const poll = h.run(root, path.join(root, "elsewhere"), ["agents"]);
      assert.equal(poll.status, 0);
      assert.match(poll.stderr, WARNING[dialect].mcp);
    }
    assert.match(hookRun(root, "UserPromptSubmit", folder).stdout, WARNING[dialect].hook);
  });

  t("an MCP server shows the shared copy once per process", () => {
    const { root } = stoppedRoot();
    post.takeBackupWarning();
    const first = call(root, 1).result;
    assert.equal(first.content.length, 2);
    assert.match(first.content[1].text, WARNING[dialect].mcp);
    assert.equal(call(root, 2).result.content.length, 1);
    assert.ok(fs.existsSync(post.layout(root).backupWarning));
  });

  t("a hook in an unregistered folder neither shows nor touches the copy", () => {
    const { root, folder } = stoppedRoot();
    const stranger = path.join(root, "other-project");
    fs.mkdirSync(stranger, { recursive: true });
    const before = fs.readFileSync(post.layout(root).backupWarning, "utf8");
    assert.equal(hookRun(root, "UserPromptSubmit", stranger).stdout, "");
    assert.equal(fs.readFileSync(post.layout(root).backupWarning, "utf8"), before);
    assert.match(hookRun(root, "UserPromptSubmit", folder).stdout, WARNING[dialect].hook);
  });

  t("an expired copy is not shown and its first reader removes it", () => {
    const rewrite = (file, atMs) => {
      const copy = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...copy, [h.key("at_ms")]: atMs }));
    };
    const expired = stoppedRoot();
    rewrite(post.layout(expired.root).backupWarning, Date.now() - post.BACKUP_WARNING_MS - 1000);
    assert.doesNotMatch(hookRun(expired.root, "UserPromptSubmit", expired.folder).stdout, WARNING[dialect].hook);
    assert.ok(!fs.existsSync(post.layout(expired.root).backupWarning));
    const fresh = stoppedRoot();
    rewrite(post.layout(fresh.root).backupWarning, Date.now() - post.BACKUP_WARNING_MS + 60_000);
    assert.match(hookRun(fresh.root, "UserPromptSubmit", fresh.folder).stdout, WARNING[dialect].hook);
    assert.ok(fs.existsSync(post.layout(fresh.root).backupWarning));
  });
}

test("tr-v1 keeps the original project's names for the backup, the shared warning copy and their log events", () => {
  const d = post.DIALECTS["tr-v1"];
  assert.equal(d.files.agentsBackup, "ajanlar.json.yedek");
  assert.equal(d.files.backupWarning, "yedek-uyarisi.json");
  assert.equal(d.values.corrupt_file_from_backup, "bozuk_dosya_yedekten");
  assert.equal(d.values.backup_not_written, "yedek_yazilamadi");
  assert.deepEqual(
    ["main_time", "backup_time", "backup_age_s", "backup_stale", "at_ms", "copy_id", "warning"].map((name) => d.keys[name]),
    ["asil_zamani", "yedek_zamani", "yedek_yasi_sn", "yedek_eski", "an_ms", "kimlik", "uyari"],
  );
  assert.equal(post.BACKUP_WARNING_MS, 15 * 60 * 1000);
});
