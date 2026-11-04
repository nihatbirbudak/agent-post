// Tests the tr-v1 compatibility contract with literal names: the commands, flags, output fields, status, kind, verification and mode values, error codes, environment variables, root name and installed file name that existing tr-v1 clients rely on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as post from "../src/agent-post.mjs";
import { SCRIPT, cleanEnv, fake } from "./helpers.mjs";

// The contract, written out literally (not derived from the dialect table it checks).
const COMMANDS = ["ajanlar", "dogrula", "durum", "gelenler", "gonder", "gorev-ac", "gorevler", "kilitler", "okundu"];
const FLAGS = ["--kimden", "--konu", "--metin-dosya", "--tur", "--gorev-id", "--okunmamis", "--sinir", "--durum", "--alan", "--baslik"];
const FIELDS = [
  "id", "kimden", "kime", "konu", "metin", "tur", "gorev_id", "dogrulandi", "durum", "zaman", "son_gorulme", "sahip",
  "bayat", "alan", "alanlar", "baslik", "ustlenen", "ustlenme", "olusturma", "sonuc", "isaretlenen", "kip", "ajan",
];
const ERRORS = ["belirtec_gecersiz", "belirtec_gerekli", "gizli_bilgi", "kayitsiz_ajan", "kimlik_uyusmaz"];
const ENV = { root: "AJAN_POSTA_KOK", token: "AJAN_POSTA_BELIRTEC" };
// The tr-v1 spelling of the assistant agent kind (the original project registers its assistant with it).
const ASSISTANT = "jarvis";
// Error codes a tr-v1 client acts on besides ERRORS: permanent rejections and the "older post" signal.
const MORE_ERRORS = ["gecersiz_alan", "gecersiz_ad", "cok_buyuk", "bilinmeyen_komut"];
// Values a tr-v1 client compares, per field.
const VALUES = {
  agentKinds: ["claude", "codex", "api", ASSISTANT],
  agentStates: ["bosta", "calisiyor", "kota_dolu"],
  taskStates: ["acik", "ustlenildi", "bitti", "takildi", "onay_bekliyor"],
  messageKinds: ["mesaj", "gorev", "cevap"],
  taskKinds: ["kod", "arastirma", "mekanik", "diger"],
  verifications: ["klasor", "belirtec", "yok"],
  modes: ["uyari", "kesin"],
};

function keysOf(value, into = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) {
      into.add(name);
      keysOf(item, into);
    }
  }
  return into;
}

test("tr-v1 contract: commands, flags, output fields, error codes and environment variables keep their literal names", () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-contract-")), "ajan-posta");
  const used = { commands: new Set(), flags: new Set(), errors: new Set() };
  const fields = new Set();
  const cli = (cwd, args, { token, ok = true } = {}) => {
    fs.mkdirSync(cwd, { recursive: true });
    const env = cleanEnv({ [ENV.root]: root, ...(token ? { [ENV.token]: token } : {}) });
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
    used.commands.add(args[0]);
    for (const arg of args) if (arg.startsWith("--")) used.flags.add(arg);
    if (ok) {
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      const output = result.stdout.trim() ? JSON.parse(result.stdout) : null;
      keysOf(output, fields);
      return output;
    }
    assert.equal(result.status, 1, `${args.join(" ")} should fail`);
    const code = result.stderr.split(":")[0];
    used.errors.add(code);
    return code;
  };
  const elsewhere = path.join(root, "..", "elsewhere");
  const claudeFolder = path.join(root, "..", "projects", "claude");
  const textFile = path.join(root, "..", "metin.txt");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(textFile, "ayrıntı");

  // The root is new and empty: the Turkish root variable alone selects tr-v1.
  const registered = cli(elsewhere, ["kayit", "asistan", ASSISTANT]);
  assert.match(registered.belirtec, /^ajp_[A-Za-z0-9_-]{32}$/);
  cli(claudeFolder, ["kayit", "claude-a", "claude", "--klasor", claudeFolder]);
  cli(elsewhere, ["kayit", "codex", "codex"]);
  assert.ok(fs.existsSync(path.join(root, "ajanlar.json")));
  assert.equal(post.dialectOf(root), "tr-v1");

  const agents = cli(elsewhere, ["ajanlar"]);
  assert.equal(agents.asistan.tur, ASSISTANT);
  cli(elsewhere, ["durum", "codex", "kota_dolu"]);
  const verify = cli(elsewhere, ["dogrula", "--kimden", "asistan"], { token: registered.belirtec });
  assert.deepEqual(verify, { ajan: "asistan", dogrulandi: "belirtec", kip: "uyari" });

  const task = cli(elsewhere, ["gorev-ac", "--kimden", "asistan", "--baslik", "İş", "--tur", "kod", "--alan", claudeFolder, "--metin-dosya", textFile], {
    token: registered.belirtec,
  });
  assert.match(task.id, /^g-[a-z0-9]{8,12}-[a-f0-9]{6}$/);
  assert.equal(task.durum, "acik");
  const sent = cli(elsewhere, ["gonder", "claude-a", "--kimden", "asistan", "--konu", "Görev", "--tur", "gorev", "--gorev-id", task.id, "--metin-dosya", textFile], {
    token: registered.belirtec,
  });
  assert.match(sent.id, /^m-[a-z0-9]{8,12}-[a-f0-9]{6}$/);
  assert.equal(sent.dogrulandi, "belirtec");
  cli(claudeFolder, ["gonder", "asistan", "--kimden", "claude-a", "--konu", "Cevap", "--metin", "tamam", "--tur", "cevap", "--gorev-id", task.id]);
  const inbox = cli(elsewhere, ["gelenler", "asistan", "--okunmamis", "--sinir", "500"]);
  assert.deepEqual(inbox.map((m) => [m.tur, m.dogrulandi]), [["cevap", "klasor"]]);
  assert.deepEqual(cli(elsewhere, ["okundu", "asistan", inbox[0].id]), { isaretlenen: 1 });
  spawnSync(process.execPath, [SCRIPT, "gorev-al", task.id, "claude-a"], { cwd: claudeFolder, env: cleanEnv({ [ENV.root]: root }) });
  const locks = cli(elsewhere, ["kilitler"]);
  assert.deepEqual(locks.map((l) => [l.sahip, l.gorev, l.bayat]), [["claude-a", task.id, false]]);
  spawnSync(process.execPath, [SCRIPT, "gorev-bitir", task.id, "claude-a", "--durum", "bitti", "--sonuc", "Bitti."], {
    cwd: claudeFolder,
    env: cleanEnv({ [ENV.root]: root }),
  });
  const done = cli(elsewhere, ["gorevler", "--durum", "bitti"]);
  assert.deepEqual(done.map((x) => [x.id, x.ustlenen, x.sonuc]), [[task.id, "claude-a", "Bitti."]]);

  // the five error codes
  cli(elsewhere, ["gonder", "codex", "--kimden", "yok-boyle", "--konu", "a", "--metin", "b"], { ok: false });
  cli(elsewhere, ["gonder", "codex", "--kimden", "asistan", "--konu", "a", "--metin", fake("token", ": abcdef123456")], { ok: false });
  cli(elsewhere, ["dogrula", "--kimden", "asistan"], { token: "ajp_yanlis", ok: false });
  // strict mode: a folderless agent writing from a bound folder, and no token at all
  post.setTokenMode(root, "strict");
  cli(elsewhere, ["dogrula", "--kimden", "asistan"], { ok: false });
  cli(claudeFolder, ["gonder", "codex", "--kimden", "asistan", "--konu", "a", "--metin", "b", "--tur", "mesaj"], { ok: false });

  assert.deepEqual([...used.commands].filter((c) => COMMANDS.includes(c)).sort(), [...COMMANDS].sort());
  assert.deepEqual([...used.flags].filter((f) => FLAGS.includes(f)).sort(), [...FLAGS].sort());
  assert.deepEqual(FIELDS.filter((f) => !fields.has(f)), []);
  assert.deepEqual([...used.errors].sort(), [...ERRORS].sort());
  // disk format: the Turkish files and fields
  for (const name of ["ajanlar.json", "gunluk.jsonl", "ayarlar.json", "gelen", "okundu", "gorevler", "kilitler"]) {
    assert.ok(fs.existsSync(path.join(root, name)), name);
  }
  const [line] = fs.readFileSync(path.join(root, "gelen", "claude-a.jsonl"), "utf8").split("\n");
  assert.deepEqual(Object.keys(JSON.parse(line)), ["id", "zaman", "kimden", "kime", "tur", "konu", "metin", "ekler", "yanit_id", "gorev_id", "dogrulandi"]);
});

test("tr-v1 contract: root name ~/ajan-posta and installed file bin/posta.mjs; an installed copy finds its own root", () => {
  const d = post.DIALECTS["tr-v1"];
  assert.equal(d.rootName, "ajan-posta");
  assert.equal(d.files.bin, "posta.mjs");
  assert.deepEqual(d.env, ENV);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-home-"));
  const root = path.join(home, "ajan-posta");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "ajanlar.json"), JSON.stringify({ v: 1, ajanlar: {} }));
  assert.deepEqual(post.resolveRoot({}, path.join(root, "bin", "posta.mjs")), { root, hint: null });
  assert.equal(post.dialectOf(root), "tr-v1");
  assert.equal(post.layout(root).bin, path.join(root, "bin", "posta.mjs"));
  // the environment wins over the installed location
  const other = path.join(home, "other");
  assert.deepEqual(post.resolveRoot({ [ENV.root]: other }, path.join(root, "bin", "posta.mjs")), { root: other, hint: "tr-v1" });
});

test("tr-v1 contract: an English name where the dialect has its own is not accepted (no silent superset)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-strict-"));
  post.initRoot(root, { dialect: "tr-v1" });
  post.register(root, { name: "asistan", kind: "assistant" });
  post.register(root, { name: "codex", kind: "codex" });
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env: cleanEnv({ [ENV.root]: root }), encoding: "utf8" });
  assert.equal(run(["send", "codex", "--kimden", "asistan", "--konu", "a", "--metin", "b"]).status, 2);
  assert.match(run(["gonder", "codex", "--kimden", "asistan", "--konu", "a", "--metin", "b", "--tur", "task"]).stderr, /^gecersiz_alan: tur: mesaj \| gorev \| cevap/);
  assert.match(run(["kayit", "x-agent", "assistant"]).stderr, new RegExp(`^gecersiz_alan: tur: claude \\| codex \\| api \\| ${ASSISTANT}\\n`));
  const call = (name, args) => post.mcpHandle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { me: "asistan", folder: null }, root).result;
  assert.match(call("send", { kime: "codex", konu: "a", metin: "b" }).content[0].text, /^bilinmeyen_arac: Bilinmeyen araç: send/);
  assert.ok(!call("gonder", { kime: "codex", konu: "a", metin: "b" }).isError);
  assert.equal(call("gonder", { to: "codex", konu: "a", metin: "b" }).isError, true);
});

test("en names: the English interface uses its own names throughout", () => {
  const d = post.DIALECTS.en;
  assert.deepEqual(post.toolList("en").map((tool) => tool.name), [
    "register", "send", "inbox", "mark_read", "agents", "set_status", "task_open", "tasks", "task_claim", "task_finish", "lock", "unlock",
  ]);
  assert.deepEqual(post.toolList("tr-v1").map((tool) => tool.name), [
    "kayit_ol", "gonder", "gelenler", "okundu", "ajanlar", "durum_yaz", "gorev_ac", "gorevler", "gorev_al", "gorev_bitir", "kilit_al", "kilit_birak",
  ]);
  assert.deepEqual(d.env, { root: "AGENT_POST_ROOT", token: "AGENT_POST_TOKEN" });
  assert.equal(d.rootName, "agent-post");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-en-"));
  post.initRoot(root, { dialect: "en" });
  post.register(root, { name: "alice", kind: "claude" });
  const line = JSON.parse(fs.readFileSync(path.join(root, "log.jsonl"), "utf8").split("\n").filter(Boolean).at(-1));
  assert.deepEqual(Object.keys(line), ["time", "event", "agent", "kind", "token"]);
  assert.deepEqual([line.event, line.token], ["register", "issued"]);
  assert.ok(fs.existsSync(path.join(root, "agents.json")) && fs.existsSync(path.join(root, "settings.json")));
  for (const name of Object.values(post.DIALECTS["tr-v1"].files)) {
    if (!name.startsWith(".")) assert.ok(!fs.existsSync(path.join(root, name)), name);
  }
});

test("tr-v1 contract: status, kind, verification and mode values and four more error codes keep their literal spellings", () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-values-")), "ajan-posta");
  const seen = Object.fromEntries(Object.keys(VALUES).map((name) => [name, new Set()]));
  const run = (cwd, args, token) => {
    fs.mkdirSync(cwd, { recursive: true });
    const env = cleanEnv({ [ENV.root]: root, ...(token ? { [ENV.token]: token } : {}) });
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });
    return { status: result.status, code: result.stderr.split(":")[0], json: () => JSON.parse(result.stdout) };
  };
  const ok = (cwd, args, token) => {
    const result = run(cwd, args, token);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.code}`);
    return result.json();
  };
  const base = path.join(root, "..");
  const folder = path.join(base, "projects", "claude");
  const elsewhere = path.join(base, "elsewhere");
  fs.mkdirSync(root, { recursive: true });

  ok(folder, ["kayit", "claude-a", "claude", "--klasor", folder]);
  ok(elsewhere, ["kayit", "codex-a", "codex"]);
  ok(elsewhere, ["kayit", "api-a", "api"]);
  const token = ok(elsewhere, ["kayit", "asistan", ASSISTANT]).belirtec;
  for (const agent of Object.values(ok(elsewhere, ["ajanlar"]))) seen.agentKinds.add(agent.tur);
  for (const state of VALUES.agentStates) seen.agentStates.add(ok(elsewhere, ["durum", "codex-a", state]).durum);

  const open = (kind, extra = []) => ok(elsewhere, ["gorev-ac", "--kimden", "asistan", "--baslik", kind, "--metin", "x", "--tur", kind, ...extra], token);
  const tasks = Object.fromEntries(VALUES.taskKinds.map((kind) => [kind, open(kind)]));
  for (const task of Object.values(tasks)) seen.taskKinds.add(task.tur);
  seen.taskStates.add(tasks.kod.durum);
  seen.taskStates.add(ok(folder, ["gorev-al", tasks.kod.id, "claude-a"]).durum);
  seen.taskStates.add(ok(folder, ["gorev-bitir", tasks.kod.id, "claude-a", "--durum", "onay_bekliyor", "--sonuc", "onay"]).durum);
  seen.taskStates.add(ok(folder, ["gorev-bitir", tasks.kod.id, "claude-a", "--durum", "bitti", "--sonuc", "tamam"]).durum);
  ok(folder, ["gorev-al", tasks.mekanik.id, "claude-a"]);
  seen.taskStates.add(ok(folder, ["gorev-bitir", tasks.mekanik.id, "claude-a", "--durum", "takildi", "--sonuc", "engel"]).durum);
  for (const state of VALUES.taskStates) {
    assert.ok(ok(elsewhere, ["gorevler", "--durum", state]).every((task) => task.durum === state), state);
  }
  open("diger", ["--kime", "codex-a"]);

  seen.verifications.add(ok(folder, ["gonder", "codex-a", "--kimden", "claude-a", "--konu", "a", "--metin", "b"]).dogrulandi);
  seen.verifications.add(ok(elsewhere, ["gonder", "codex-a", "--kimden", "asistan", "--konu", "a", "--metin", "b", "--tur", "cevap"], token).dogrulandi);
  seen.verifications.add(ok(elsewhere, ["gonder", "codex-a", "--kimden", "api-a", "--konu", "a", "--metin", "b"]).dogrulandi);
  for (const box of ["codex-a", "asistan"]) for (const message of ok(elsewhere, ["gelenler", box])) seen.messageKinds.add(message.tur);
  seen.modes.add(ok(elsewhere, ["dogrula", "--kimden", "asistan"], token).kip);
  post.setTokenMode(root, "strict");
  seen.modes.add(ok(elsewhere, ["dogrula", "--kimden", "asistan"], token).kip);

  for (const [name, values] of Object.entries(VALUES)) assert.deepEqual([...seen[name]].sort(), [...values].sort(), name);
  const codes = [
    run(elsewhere, ["durum", "codex-a", "uyuyor"]),
    run(elsewhere, ["kayit", "X", "claude"]),
    run(folder, ["gonder", "codex-a", "--kimden", "claude-a", "--konu", "ğ".repeat(101), "--metin", "b"]),
    run(elsewhere, ["uc"]),
  ];
  assert.deepEqual(codes.map((result) => [result.status, result.code]), [
    [1, "gecersiz_alan"],
    [1, "gecersiz_ad"],
    [1, "cok_buyuk"],
    [2, "bilinmeyen_komut"],
  ]);
  assert.deepEqual(codes.map((result) => result.code), MORE_ERRORS);
});
