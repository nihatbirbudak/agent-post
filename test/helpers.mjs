// Test helpers: a fresh post root per dialect, and the dialect's outside names for CLI, MCP, disk and log checks.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as post from "../src/agent-post.mjs";

export const CORE = fileURLToPath(new URL("../src/agent-post.mjs", import.meta.url));
export const SCRIPT = fileURLToPath(new URL("../bin/agent-post.mjs", import.meta.url));
export const DIALECT_NAMES = Object.keys(post.DIALECTS);

/** Joins parts at run time, so that fake secrets in tests never appear whole in the source (secret scanners). */
export const fake = (...parts) => parts.join("");

/** Environment for a child process with only the given post variables set. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const d of Object.values(post.DIALECTS)) {
    delete env[d.env.root];
    delete env[d.env.token];
  }
  return { ...env, ...extra };
}

/** Helpers bound to one dialect. Tests are written with English names; these translate at the boundary. */
export function harness(dialect) {
  const d = post.DIALECTS[dialect];
  const key = (name) => d.keys[name] ?? name;
  const value = (name) => d.values[name] ?? name;
  const command = (name) => d.commands[name] ?? name;
  const flag = (name) => d.flags[name] ?? name;
  const error = (name) => d.errors[name] ?? name;
  const tool = (name) => d.tools[name] ?? name;
  const enumFlags = new Set(["kind", "status"]);

  /** English argv to the dialect's argv (command, flags and enum flag values). */
  function argv(english) {
    const out = [];
    for (let i = 0; i < english.length; i++) {
      const part = english[i];
      if (i === 0) {
        out.push(command(part));
      } else if (part.startsWith("--")) {
        const name = part.slice(2);
        out.push(`--${flag(name)}`);
        if (enumFlags.has(name) && i + 1 < english.length && !english[i + 1].startsWith("--")) out.push(value(english[++i]));
      } else {
        out.push(part);
      }
    }
    return out;
  }

  /** A root with three agents: alice and bob bound to folders, operator without a folder. */
  function newRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-"));
    post.initRoot(root, { dialect });
    post.register(root, { name: "alice", kind: "claude", folder: path.join(root, "projects", "alice") });
    post.register(root, { name: "bob", kind: "codex", folder: path.join(root, "projects", "bob") });
    post.register(root, { name: "operator", kind: "assistant" });
    return root;
  }

  /** Runs the CLI in `cwd` with English argv; `token` goes into the dialect's token variable. */
  function run(root, cwd, english, { token, input, raw = false } = {}) {
    fs.mkdirSync(cwd, { recursive: true });
    const env = cleanEnv({ [d.env.root]: root, ...(token !== undefined ? { [d.env.token]: token } : {}) });
    const result = spawnSync(process.execPath, [SCRIPT, ...(raw ? english : argv(english))], { cwd, env, input, encoding: "utf8" });
    const parse = () => post.fromDisk(root, JSON.parse(result.stdout));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: parse };
  }

  /** Calls one MCP tool with English names; returns the English result or `{ error }`. */
  function mcp(root, state, name, args) {
    const request = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool(name), arguments: post.toDisk(root, args) } };
    const { result } = post.mcpHandle(request, state, root);
    return result.isError ? { error: result.content[0].text } : post.fromDisk(root, JSON.parse(result.content[0].text));
  }

  function lines(file) {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  function logEvents(root, event) {
    return lines(post.layout(root).log)
      .map((line) => post.fromDisk(root, JSON.parse(line)))
      .filter((entry) => entry.event === event);
  }

  return { d, dialect, key, value, command, flag, error, tool, argv, newRoot, run, mcp, lines, logEvents };
}
