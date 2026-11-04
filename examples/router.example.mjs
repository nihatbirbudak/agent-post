// Example router: once per run, hands each open task without a recipient to an idle, recently seen agent whose areas are free, by sending it a task message (see docs/routing.md).
//
// Usage: node examples/router.example.mjs --as router [--state router-state.json]
// The router must be a registered agent; give its token in AGENT_POST_TOKEN if it has no folder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AREA_SILENCE_MS, agentList, areaKey, locks, resolveRoot, send, tasks } from "../src/agent-post.mjs";

// Which agent kinds to prefer for which task kind (first match wins).
const PREFERENCE = {
  code: ["claude", "codex"],
  research: ["claude", "codex"],
  mechanical: ["api", "codex"],
  other: ["claude", "codex", "api"],
};

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function overlaps(a, b) {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { routed: {} };
  }
}

/** The agent that should get `task`, or null. */
export function choose(task, agents, held, now = Date.now()) {
  const areas = task.areas.map(areaKey);
  const fits = (agent) =>
    agent.status === "idle" &&
    now - (Date.parse(agent.last_seen) || 0) <= AREA_SILENCE_MS &&
    !held.some((lock) => lock.owner !== agent.name && !lock.stale && areas.some((area) => overlaps(area, lock.area)));
  for (const kind of PREFERENCE[task.kind] ?? PREFERENCE.other) {
    const found = Object.values(agents).find((agent) => agent.kind === kind && agent.name !== task.from && fits(agent));
    if (found) return found.name;
  }
  return null;
}

export function routeOnce(root, me, stateFile) {
  const state = readState(stateFile);
  const agents = agentList(root);
  const held = locks(root);
  const routed = [];
  for (const task of tasks(root, { status: "open" })) {
    if (task.to || state.routed[task.id]) continue;
    const agent = choose(task, agents, held);
    if (!agent) continue;
    send(root, {
      from: me,
      to: agent,
      kind: "task",
      subject: task.title,
      text: `Task ${task.id} is yours if you take it: task-claim ${task.id} ${agent}\n\n${task.text}`,
      task_id: task.id,
      folder: process.cwd(),
      token: process.env.AGENT_POST_TOKEN ?? null,
    });
    state.routed[task.id] = { agent, time: new Date().toISOString() };
    routed.push([task.id, agent]);
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return routed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const me = option("as");
  if (!me) {
    process.stderr.write("--as <router name> is required.\n");
    process.exitCode = 1;
  } else {
    const routed = routeOnce(resolveRoot().root, me, option("state", "router-state.json"));
    console.log(JSON.stringify({ routed }, null, 2));
  }
}
