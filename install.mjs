// Installs agent-post: copies the core into the post root's bin folder, declares the root's dialect and registers the agents from a config file (safe to run again).
//
// Usage: node install.mjs [--config agents.json] [--root DIR] [--dialect en|tr-v1] [--issue-tokens] [--mode warn|strict]
//   --config        JSON file: { "dialect"?, "approver"?, "agents": [{ "name", "kind", "account"?, "folder"?, "token_hint"? }] }
//                   (folders may start with ~ or be relative to the config file)
//   --root          post root (default: the dialect's root variable, or ~/agent-post)
//   --dialect       dialect of a new root (default: the config's, the existing root's, or en)
//   --issue-tokens  gives a token to every registered agent that has none
//   --mode          writes the token mode (warn is the default)
// New and issued plain tokens appear once, in this output only; the registry keeps their SHA-256 digest.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DIALECTS, TOKEN_MODES, dialectOf } from "./src/agent-post.mjs";

const SOURCE = fileURLToPath(new URL("./src/agent-post.mjs", import.meta.url));

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}

function expand(folder, base) {
  if (!folder) return null;
  const home = folder === "~" || folder.startsWith("~/") || folder.startsWith("~\\");
  return path.resolve(home ? path.join(os.homedir(), folder.slice(1)) : path.resolve(base, folder));
}

function readConfig(file) {
  if (!file) return { agents: [] };
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!config || typeof config !== "object" || (config.agents !== undefined && !Array.isArray(config.agents))) {
    throw new Error("The config must be an object with an \"agents\" list.");
  }
  const base = path.dirname(path.resolve(file));
  const agents = (config.agents ?? []).map((agent) => ({ ...agent, folder: expand(agent.folder, base) }));
  return { ...config, agents };
}

function chooseRoot(args, dialect) {
  const given = option(args, "root");
  if (given) return path.resolve(given);
  const names = dialect ? [DIALECTS[dialect]] : Object.values(DIALECTS);
  for (const d of names) if (process.env[d.env.root]) return path.resolve(process.env[d.env.root]);
  return path.join(os.homedir(), (dialect ? DIALECTS[dialect] : DIALECTS.en).rootName);
}

/** Runs the install; returns the report printed by the command line. */
export async function install(args) {
  const config = readConfig(option(args, "config"));
  const asked = option(args, "dialect") ?? config.dialect ?? null;
  if (asked !== null && !(asked in DIALECTS)) throw new Error(`--dialect must be ${Object.keys(DIALECTS).join(" | ")}.`);
  const mode = option(args, "mode");
  if (mode !== null && !TOKEN_MODES.includes(mode)) throw new Error(`--mode must be ${TOKEN_MODES.join(" | ")}.`);
  const root = chooseRoot(args, asked);
  const marked = Object.values(DIALECTS).some((d) =>
    [d.files.settings, d.files.agents, d.files.log].some((name) => fs.existsSync(path.join(root, name))),
  );
  const declared = marked ? dialectOf(root) : null;
  if (declared && asked && declared !== asked) throw new Error(`The root at ${root} uses the ${declared} dialect, not ${asked}.`);
  const dialect = declared ?? asked ?? "en";
  const d = DIALECTS[dialect];

  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const target = path.join(bin, d.files.bin);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.copyFileSync(SOURCE, temporary);
  if (digest(temporary) !== digest(SOURCE)) throw new Error("The copy could not be verified.");
  fs.renameSync(temporary, target);

  const post = await import(pathToFileURL(target).href);
  post.initRoot(root, { dialect, ...(config.approver !== undefined ? { approver: config.approver } : {}) });
  const registered = post.agents(root);
  const added = [];
  const tokens = {};
  const hints = {};
  for (const agent of config.agents) {
    if (agent.token_hint) hints[agent.name] = String(agent.token_hint);
    if (registered[agent.name]) continue;
    const { name, kind, account = null, folder = null } = agent;
    tokens[name] = post.register(root, { name, kind, account, folder }).token;
    added.push(name);
  }
  if (args.includes("--issue-tokens")) {
    for (const [name, agent] of Object.entries(post.agents(root))) {
      if (!agent.token_digest) tokens[name] = post.issueToken(root, name);
    }
  }
  if (mode !== null) post.setTokenMode(root, mode);
  const all = post.agents(root);
  const where = Object.fromEntries(
    Object.keys(tokens).map((name) => [
      name,
      hints[name] ??
        (all[name]?.folder
          ? "verified from its folder; no need to store the token"
          : `pass it as the register tool's token argument or in ${d.env.token}`),
    ]),
  );
  return {
    root,
    dialect,
    file: target,
    sha256: digest(target),
    added,
    agents: Object.keys(all),
    token_mode: post.tokenMode(root),
    tokens,
    where,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await install(process.argv.slice(2)), null, 2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
