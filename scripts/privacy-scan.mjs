// Scans the repository before publishing: private terms from a list kept outside the repository, secrets (the post's own filter), private network addresses, personal home paths, extra drive roots and e-mail addresses; with --git also every commit's files and metadata. Prints where, never the value.
//
// Usage: node scripts/privacy-scan.mjs [--terms-file F]... [--term T]... [--allow-term-in FILE=TERM]... [--git] [--root DIR]
//   --terms-file     one private term per line (# starts a comment); keep this file outside the repository
//   --term           one private term
//   --allow-term-in  FILE=TERM: a private term expected in one file (for example the copyright line in LICENSE);
//                    FILE alone allows every term in that file
//   --git            also scan every commit's files, author and committer names, e-mail addresses and messages
// Exit code 1 when something is found.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { looksSecret } from "../src/agent-post.mjs";

const HOME_NAMES = new Set(["alice", "bob", "user", "username", "you", "name", "example", "runner", "public", "default"]);
const PRIVATE_ADDRESS = /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/;
const HOME_PATH = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'`<>]+)/gi;
const DRIVE_ROOT = /(?<![A-Za-z0-9])[D-Zd-z]:[\\/]/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /(?:^noreply@[A-Za-z0-9.-]+|@users\.noreply\.github\.com|@example\.(?:com|org|net))$/i;
// Source code names its token fields (`token: tokenArg(…)`, `token: "AGENT_POST_TOKEN"`). Before the secret check such
// assignments are masked when the value is clearly code: a call or `??`, a member expression, an identifier without
// digits ending an entry, or a quoted literal that is upper-case, lower-case without digits, or contains a space.
// Labels are matched case-sensitively (code spells them in lower case); any other value is still checked.
const CODE_ASSIGNMENT = new RegExp(
  String.raw`[\p{L}_-]*?(?:token|secret|password|passwd|pwd|parola|şifre|jeton|key|anahtar)[\p{L}_-]*["']?\s*[:=]\s*` +
    String.raw`(?:"[^"\n]*\s[^"\n]*"|["'][A-Z0-9_]+["']|["'][\p{Ll}_-]+["']|[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]\n]*\])*\s*(?:\(|\?\?)|` +
    String.raw`[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]\n]*\])+|[A-Za-z_$]+(?=\s*[,})\]]))`,
  "gu",
);

function parseArgs(argv) {
  const options = { terms: [], allow: [], git: false, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value.`);
      return argv[++i];
    };
    if (name === "--terms-file") {
      const lines = fs.readFileSync(value(), "utf8").split(/\r?\n/);
      options.terms.push(...lines.map((line) => line.replace(/#.*/, "").trim()).filter(Boolean));
    } else if (name === "--term") options.terms.push(value());
    else if (name === "--allow-term-in") {
      const [file, term = null] = value().split("=");
      options.allow.push({ file: file.replace(/\\/g, "/"), term: term?.toLocaleLowerCase("en") ?? null });
    }
    else if (name === "--git") options.git = true;
    else if (name === "--root") options.root = path.resolve(value());
    else throw new Error(`Unknown option: ${name}`);
  }
  return options;
}

/** Findings of one text (a file's content or a commit's metadata): `{ line, check }` without the matched value.
 * `allowTerms`: true allows every term, a list allows those terms (lower case). */
export function scanText(text, { terms = [], allowTerms = false } = {}) {
  const allowed = (term) => allowTerms === true || (Array.isArray(allowTerms) && allowTerms.includes(term));
  const findings = [];
  const lowered = terms.map((term) => term.toLocaleLowerCase("en"));
  text.split(/\r?\n/).forEach((line, index) => {
    const add = (check) => findings.push({ line: index + 1, check });
    const lower = line.toLocaleLowerCase("en");
    lowered.forEach((term, n) => {
      if (lower.includes(term)) add(allowed(term) ? `allowed private term #${n + 1}` : `private term #${n + 1}`);
    });
    if (looksSecret(line.replace(CODE_ASSIGNMENT, ""))) add("secret");
    if (PRIVATE_ADDRESS.test(line)) add("private network address");
    for (const match of line.matchAll(HOME_PATH)) {
      if (!HOME_NAMES.has(match[1].toLowerCase()) && !match[1].startsWith("<") && !match[1].startsWith("$")) add("home path");
    }
    if (DRIVE_ROOT.test(line)) add("drive root");
    for (const match of line.matchAll(EMAIL)) if (!EMAIL_OK.test(match[0])) add("e-mail address");
  });
  return findings;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

function isRepository(root) {
  return spawnSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).status === 0;
}

function walk(root, folder = root, out = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(root, full, out);
    else out.push(path.relative(root, full).replace(/\\/g, "/"));
  }
  return out;
}

/** Scans the working tree (and with `git` every commit); returns the findings. */
export function scan({ root, terms = [], allow = [], git: withHistory = false }) {
  const findings = [];
  const file = (name, text, where = name) => {
    const rules = allow.filter((rule) => rule.file === name);
    const allowTerms = rules.some((rule) => rule.term === null) || rules.map((rule) => rule.term);
    for (const finding of scanText(text, { terms, allowTerms })) findings.push({ where, ...finding });
  };
  const files = isRepository(root)
    ? git(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean)
    : walk(root);
  for (const name of files) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) file(name, fs.readFileSync(full, "utf8"));
  }
  if (withHistory && isRepository(root)) {
    const commits = git(root, ["rev-list", "--all"]).split("\n").filter(Boolean);
    for (const commit of commits) {
      const short = commit.slice(0, 12);
      const people = git(root, ["show", "-s", "--format=%an%n%ae%n%cn%n%ce", commit]).split("\n");
      for (const [index, label] of [[1, "author e-mail"], [3, "committer e-mail"]]) {
        if (!EMAIL_OK.test(people[index] ?? "")) findings.push({ where: `commit ${short}`, line: 0, check: `${label} is not a noreply address` });
      }
      for (const [index, label] of [[0, "author name"], [2, "committer name"]]) {
        for (const finding of scanText(people[index] ?? "", { terms, allowTerms: true })) {
          findings.push({ where: `commit ${short} ${label}`, line: 0, check: finding.check });
        }
      }
      file("(commit message)", git(root, ["show", "-s", "--format=%B", commit]), `commit ${short} message`);
      for (const name of git(root, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean)) {
        file(name, git(root, ["show", `${commit}:${name}`]), `commit ${short}:${name}`);
      }
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const findings = scan(options);
    const blocking = findings.filter((finding) => !finding.check.startsWith("allowed"));
    for (const finding of findings) console.log(`${finding.where}:${finding.line}\t${finding.check}`);
    console.log(`${blocking.length} finding(s), ${findings.length - blocking.length} allowed; ${options.terms.length} private term(s) checked.`);
    process.exitCode = blocking.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
