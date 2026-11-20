// Installs agent-post: copies the core into the post root's bin folder, declares the root's dialect, registers the agents of a config file and corrects their records (safe to run again; upgrades an existing root in place).
//
// Usage: node install.mjs [--config agents.json] [--root DIR] [--dialect en|tr-v1] [--issue-tokens] [--mode warn|strict]
//   --config        JSON file: { "dialect"?, "approver"?, "protect_unaddressed"?, "agents": [{ "name", "kind",
//                   "account"?, "folder"?, "default"?, "reserved"?, "protected"?, "token_hint"? }] }
//                   (folders may start with ~ or be relative to the config file)
//   --root          post root (default: the dialect's root variable, or ~/agent-post)
//   --dialect       dialect of a new root (default: the config's, the existing root's, or en)
//   --issue-tokens  gives a token to every registered agent that has none
//   --mode          writes the token mode (warn is the default)
// The config is authoritative for the agents it lists: every run brings their kind, folder (none when the config gives
// none) and `default` mark to the config's values and marks them installed. `reserved` names are registered only by
// this installer and act only with their token; a reserved name that someone else registered first is taken back with
// a new token. `protected` agents are reached only by installed, token-verified senders that are not of kind codex.
// Agents missing from the config are kept; only a codex agent bound to an installed Claude agent's folder loses that
// binding. New and issued plain tokens appear once, in this output only; the registry keeps their SHA-256 digest.

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
  if (!file) return { agents: [], given: false };
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!config || typeof config !== "object" || (config.agents !== undefined && !Array.isArray(config.agents))) {
    throw new Error("The config must be an object with an \"agents\" list.");
  }
  const base = path.dirname(path.resolve(file));
  const agents = (config.agents ?? []).map((agent) => ({ ...agent, folder: expand(agent.folder, base) }));
  const names = agents.map((agent) => agent.name);
  const twice = names.filter((name, index) => names.indexOf(name) !== index);
  if (twice.length) throw new Error(`The config lists an agent more than once: ${[...new Set(twice)].join(", ")}`);
  return { ...config, agents, given: true };
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
  // a config is the list of record: it sets both lists (and clears a list it no longer marks anyone for); a run
  // without a config keeps them, and a root that never used them gets no new settings
  const lists = {};
  if (config.given && fs.existsSync(path.join(root, d.files.settings))) {
    lists.reserved_names = post.reservedNames(root);
    lists.protected_agents = post.protectedAgents(root);
  }
  for (const [field, flag] of [["reserved_names", "reserved"], ["protected_agents", "protected"]]) {
    const names = config.agents.filter((agent) => agent[flag] === true).map((agent) => agent.name);
    if (config.given && (names.length || lists[field]?.length)) lists[field] = names;
    else delete lists[field];
  }
  post.initRoot(root, {
    dialect,
    ...(config.approver !== undefined ? { approver: config.approver } : {}),
    ...lists,
    ...(config.protect_unaddressed !== undefined ? { protect_unaddressed: config.protect_unaddressed } : {}),
  });

  const before = post.agents(root);
  const added = [];
  const corrected = {};
  const takenBack = [];
  const tokens = {};
  const hints = {};
  // Claude agents first: a codex agent's folder is checked against the installed Claude folders
  const order = [...config.agents].sort((a, b) => Number(b.kind === "claude") - Number(a.kind === "claude"));
  for (const agent of order) {
    const { name, kind, account = null, folder = null } = agent;
    if (agent.token_hint) hints[name] = String(agent.token_hint);
    if (kind === "codex" && folder && post.codexFolderForbidden(root, folder)) {
      throw new Error(`${name}: an agent of kind codex cannot be bound to an installed Claude agent's folder (${folder}).`);
    }
    const old = before[name];
    // a reserved name registered by someone other than the installer is taken back: its old token stops working
    const taken = Boolean(old && agent.reserved === true && !old.installed);
    const result = post.register(root, {
      name,
      kind,
      account,
      folder,
      install: true,
      default: agent.default === true,
      new_token: taken,
    });
    if (result.token) tokens[name] = result.token;
    if (!old) added.push(name);
    else if (result.corrected.length) corrected[name] = result.corrected;
    if (taken) takenBack.push(name);
  }
  const kept = [];
  const unbound = [];
  for (const [name, agent] of Object.entries(post.agents(root))) {
    if (config.agents.some((listedAgent) => listedAgent.name === name)) continue;
    if (agent.kind === "codex" && agent.folder && post.codexFolderForbidden(root, agent.folder)) {
      post.unbindFolder(root, name);
      unbound.push(name);
    } else {
      kept.push(name);
    }
  }
  if (args.includes("--issue-tokens")) {
    for (const [name, agent] of Object.entries(post.agents(root))) {
      if (!agent.token_digest) tokens[name] = post.issueToken(root, name);
    }
  }
  if (mode !== null) post.setTokenMode(root, mode);
  const all = post.agents(root);
  const reserved = post.reservedNames(root);
  const where = Object.fromEntries(
    Object.keys(tokens).map((name) => [
      name,
      hints[name] ??
        (reserved.includes(name)
          ? `a reserved name acts only with its token: store it where this agent's sessions read ${d.env.token}`
          : all[name]?.folder
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
    corrected,
    taken_back: takenBack,
    kept,
    unbound,
    agents: Object.keys(all),
    reserved,
    protected: post.protectedAgents(root),
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
