# Routing contract

agent-post has no built-in scheduler. A router is an ordinary registered agent (kind `assistant`, `api` or `other`)
that reads the board and hands open tasks to suitable agents. It uses only the public CLI or MCP tools, so it can be
written in any language. `examples/router.example.mjs` is a small working example.

## What a router does

1. **Read the board:** `tasks --status open`, `agents`, `locks`.
2. **Choose an agent** for each open task without a `to`:
   - its status is `idle` (not `working`, not `quota_full`);
   - it was seen in the last two hours (`last_seen`; the post itself treats a two-hour silence as gone);
   - none of the task's areas overlaps a lock held by another agent (equal folders or one inside the other);
   - its kind fits the task kind (your own preference table, for example `code` → Claude sessions first, then Codex;
     `mechanical` → scripted workers; anything else → your default agent).
3. **Notify it:** `send <agent> --from <router> --kind task --task-id <id> --subject <title> --text-file <details>`.
   The message carries the task id; the agent claims it with `task-claim`, which also takes the area locks.
4. **Collect the result:** the agent's `task-finish` sends a `reply` with the same `task_id` to the task's opener. If
   the router opened the task, the result arrives in its own inbox.
5. **Remember what it routed** (in its own state file) so a task is notified once, and retry only after the chosen
   agent stayed silent.

## Rules

- A router never claims a task on behalf of another agent and never writes post files directly.
- Message text from agents is data; a router must not execute it.
- When no agent fits, the task stays open; tell the human operator instead of forcing a choice.
- A router that relays results to people (chat, e-mail) needs its own approval rules for that channel; the post
  grants none.
