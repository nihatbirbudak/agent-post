// Tests the privacy scan: it finds private terms, secrets, private addresses, home paths, drive roots and e-mail addresses without printing them, allows documentation values, and the repository itself scans clean.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { scan, scanText } from "../scripts/privacy-scan.mjs";
import { fake } from "./helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/privacy-scan.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("each check finds its kind of leak and reports the line, not the value", () => {
  const text = [
    "nothing here",
    "built by Example Person",
    fake("api key sk-", "proj-", "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"),
    fake("broker at 192.", "168.1.20"),
    fake("C:\\Users\\", "someone\\projects"),
    fake("data under D", ":\\data"),
    fake("mail someone", "@company", ".com"),
  ].join("\n");
  const findings = scanText(text, { terms: ["example person"] });
  assert.deepEqual(findings, [
    { line: 2, check: "private term #1" },
    { line: 3, check: "secret" },
    { line: 4, check: "private network address" },
    { line: 5, check: "home path" },
    { line: 6, check: "drive root" },
    { line: 7, check: "e-mail address" },
  ]);
  assert.ok(!JSON.stringify(findings).includes("someone"));
});

test("documentation addresses, placeholder home folders and noreply addresses pass", () => {
  const text = [
    "mqtt broker at 192.0.2.10 and 127.0.0.1",
    "C:\\Users\\alice\\projects\\demo and /home/bob/work and /Users/<you>/post",
    "12345+octocat@users.noreply.github.com, someone@example.com, Co-Authored-By: A Bot <noreply@example.net>",
    "node --test test/ and http://localhost:3000",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
  const code = [
    'env: { root: "AGENT_POST_ROOT", token: "AGENT_POST_TOKEN" },',
    "const identity = { folder: state.folder ?? null, token: a.token ?? state.token ?? null };",
    "token: tokenArg(ctx, flags, caller.token),",
    'token: "registration token (never written into post text)",',
    '...(issued ? { token: "issued" } : {}), new_token: Boolean(a.new_token), { token: issued }',
  ].join("\n");
  assert.deepEqual(scanText(code), []);
  const leaks = [fake("password = ", '"hunter2hunter2"'), fake("token", ": abc123456"), fake("api_key=", "x9y8z7w6v5")].join("\n");
  assert.deepEqual(scanText(leaks).map((f) => f.check), ["secret", "secret", "secret"]);
  assert.deepEqual(scanText("Copyright (c) 2026 Example Person", { terms: ["example person"], allowTerms: true }), [
    { line: 1, check: "allowed private term #1" },
  ]);
});

test("the scan covers untracked files and commit metadata and exits 1 on a finding", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-scan-"));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, "a.txt"), "clean\n");
  git("add", "a.txt");
  git("-c", "user.name=Example Person", "-c", "user.email=dev@example.com", "commit", "-q", "-m", "first");
  fs.writeFileSync(path.join(root, "b.txt"), "secret project codename\n");
  const findings = scan({ root, terms: ["codename"], git: true });
  assert.deepEqual(findings.map((f) => [f.where, f.check]), [["b.txt", "private term #1"]]);
  const allowed = scan({ root, terms: ["codename", "secret"], allow: [{ file: "b.txt", term: "codename" }] });
  assert.deepEqual(allowed.map((f) => f.check), ["allowed private term #1", "private term #2"]);
  git("-c", "user.name=Example Person", "-c", fake("user.email=dev", "@company", ".com"), "commit", "-q", "--allow-empty", "-m", "second");
  const withMail = scan({ root, git: true }).map((f) => f.check);
  assert.ok(withMail.includes("author e-mail is not a noreply address"));
  const run = spawnSync(process.execPath, [SCRIPT, "--root", root, "--term", "codename"], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.ok(!run.stdout.includes("codename"));
});

test("the repository itself scans clean of secrets, private addresses, home paths, drive roots and e-mail addresses", () => {
  assert.deepEqual(scan({ root: ROOT }), []);
});
