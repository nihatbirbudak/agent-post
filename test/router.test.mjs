// Tests the example router: it hands an open task to an idle, recently seen agent of the preferred kind whose areas are free, once, and leaves tasks that fit nobody open.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as post from "../src/agent-post.mjs";
import { routeOnce } from "../examples/router.example.mjs";

test("the example router routes each open task once, by kind, status and free areas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-post-router-"));
  post.initRoot(root, { dialect: "en" });
  post.register(root, { name: "alice", kind: "claude", folder: path.join(root, "alice") });
  post.register(root, { name: "bob", kind: "codex", folder: path.join(root, "bob") });
  post.register(root, { name: "worker", kind: "api" });
  post.register(root, { name: "router", kind: "assistant", folder: path.join(root, "router") });
  const shared = path.join(root, "shared");
  const code = post.openTask(root, { from: "router", title: "Code", text: "x", kind: "code", areas: [shared] });
  const chore = post.openTask(root, { from: "router", title: "Chore", text: "y", kind: "mechanical" });
  post.setStatus(root, "alice", { status: "quota_full" });
  post.lock(root, "worker", [path.join(shared, "sub")]);
  const state = path.join(root, "router-state.json");
  const cwd = process.cwd();
  fs.mkdirSync(path.join(root, "router"), { recursive: true });
  process.chdir(path.join(root, "router"));
  try {
    // code: alice is out of quota, bob is free but the area is locked by worker; chore: worker fits
    assert.deepEqual(routeOnce(root, "router", state), [[chore.id, "worker"]]);
    post.unlock(root, "worker");
    assert.deepEqual(routeOnce(root, "router", state), [[code.id, "bob"]]);
    assert.deepEqual(routeOnce(root, "router", state), []);
  } finally {
    process.chdir(cwd);
  }
  const [message] = post.inbox(root, "bob");
  assert.deepEqual([message.kind, message.task_id, message.verified], ["task", code.id, "folder"]);
});
