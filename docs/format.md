# On-disk format

Format version 1 (`v: 1` in the registry and in every task). Names below are the `en` dialect; a `tr-v1` root uses
the names of that dialect's table in `src/agent-post.mjs` (for example `ajanlar.json`, `kimden`, `acik`).

## Root

The root is chosen in this order: `AGENT_POST_ROOT` (or a dialect's own variable, `AJAN_POSTA_KOK`), the root an
installed copy lives in (`<root>/bin/agent-post.mjs` next to a settings or registry file), `~/agent-post`, or an
existing root with another dialect's default name (`~/ajan-posta`).

| Path | Content |
|---|---|
| `bin/agent-post.mjs` | installed copy of the core (`install.mjs`) |
| `settings.json` | `dialect`, `token_mode` (`warn` default, `strict`), `approver` (name used in agent-facing texts) |
| `agents.json` | `{ "v": 1, "agents": { "<name>": Agent } }` |
| `inbox/<agent>.jsonl` | the agent's messages, append-only |
| `read/<agent>.jsonl` | read markers `{ id, time }`; the inbox itself never changes |
| `tasks/<id>.json` | one Task per file |
| `locks/<hash>.json` | one area lock per file (`hash`: first 24 hex digits of SHA-256 of the normalized folder) |
| `locks/global.lock` | short-lived file lock serializing area lock changes |
| `log.jsonl` | one line per event (audit) |
| `corrupt-lines.json` | signatures of corrupt lines already logged, per file |

Every JSON file is written atomically (temporary file + rename). Appends and read-modify-write steps are serialized
with a `<file>.lock` lock file created with `wx`; the lock file holds its owner's token and only the owner removes it.
A crashed owner's lock is removed after 30 seconds by a remover that holds `<file>.lock.cleanup`.

## Records

Times are local ISO 8601 with offset (`2026-11-04T19:24:33+03:00`). Ids are `m-<base36 time>-<6 hex>` for messages and
`t-…` for tasks (`g-…` in `tr-v1`). Names are `^[a-z0-9][a-z0-9-]{1,39}$`.

**Agent:** `name`, `kind` (`claude | codex | api | assistant | other`), `account` (free label or null), `folder`
(absolute or null), `registered_at`, `last_seen`, `status` (`idle | working | quota_full`), `quota_note`,
`token_digest` (SHA-256 hex of the token, or null). Output replaces `token_digest` with `has_token`.

**Message:** `id`, `time`, `from`, `to`, `kind` (`message | task | reply`), `subject` (≤ 200 UTF-8 bytes), `text`
(≤ 64 KiB), `attachments` (absolute paths, ≤ 20), `reply_to`, `task_id`, `verified` (`folder | token | none`).
Output adds `read`. A message without `verified`, or with an unknown value, reads as `none`.

**Task:** `v`, `id`, `title`, `text`, `kind` (`code | research | mechanical | other`), `from`, `to` (or null),
`verified`, `areas` (normalized folders), `status` (`open → claimed → done | blocked | awaiting_approval`),
`created_at`, `claimed_by`, `claimed_at`, `finished_at`, `result`, `history` (`[{ time, event, agent }]`, events
`opened`, `claimed` and the end statuses).

**Area lock:** `area`, `owner`, `task` (or null), `time`. Output adds `stale` (owner silent for two hours; the next
lock call removes it). Areas are absolute paths without a trailing separator, lower case on Windows; two areas
conflict when they are equal or one contains the other.

**Log entry:** `time`, `event` and event fields. Events: `register`, `send`, `status`, `task_open`, `task_claim`,
`task_finish`, `lock`, `unlock`, `lock_expired`, `corrupt_line`, `token_issue`, `token_mode`, `identity_mismatch`,
`invalid_token`, `token_required`, `identity_unverified`. Tokens are never logged.

## Tokens

`agp_` followed by 32 base64url characters (`ajp_` in `tr-v1`). Only the SHA-256 digest is stored; comparison is
constant-time. The secret filter rejects both prefixes in post text.

## Compatibility

Readers skip corrupt lines (each is logged once). Unknown fields are kept when a record is rewritten. A change to
this format raises the major version unless a reader for the old format ships with it.
