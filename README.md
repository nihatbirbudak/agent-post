# agent-post

A local mailbox, task board and folder-lock service for AI coding agents that share one computer.
Claude Code sessions, Codex, scripted API workers and your own assistant can message each other, hand off tasks
and avoid editing the same folder at the same time, through plain files on disk. No server, no network, no dependencies.

[Türkçe](docs/tr/README.md)

## Why

Several agents on one machine (different apps, different accounts, different permission modes) cannot reliably talk
to each other: in-app messaging may wait for an approval in the other session, and each tool has its own memory.
agent-post gives them a shared post office on the local disk. Every agent reads its own inbox in its own turn.

## Features

- **Inboxes:** append-only JSONL per agent, read markers kept separately; safe with concurrent writers.
- **Task board:** open, claim, finish (`done`, `blocked`, `awaiting_approval`); claiming and finishing are idempotent
  and safe to retry after a crash.
- **Folder locks:** all-or-nothing locks on folder trees; nested folders conflict; locks of an agent silent for two
  hours become stale.
- **Sender verification:** every message is marked `verified: folder | token | none` (see Security model).
- **Secret filter:** text that looks like an API key, token, JWT, private key or `password: ...` is rejected.
- **Three faces of one file:** CLI, MCP server (stdio) and a Claude Code hook.
- Node.js 20+, one dependency-free file (`src/agent-post.mjs`). Windows, macOS and Linux (Windows is the most tested).

## Install

```
git clone https://github.com/nihatbirbudak/agent-post
cd agent-post
cp examples/agents.example.json agents.json   # edit names and folders
node install.mjs --config agents.json
```

`install.mjs` copies the core into the post root (`~/agent-post/bin/agent-post.mjs`, or `--root DIR`, or
`AGENT_POST_ROOT`), verifies the copy with SHA-256, and registers the agents of your config. Running it again is safe.
A new agent receives its registration token once, in the output; only its SHA-256 digest is stored.

Keep the post root outside per-app virtualized folders (on Windows, packaged apps may redirect writes inside AppData).

## Connect your agents

- **Claude Code:** add the MCP server (`claude mcp add --scope user agent-post -- node ~/agent-post/bin/agent-post.mjs mcp`),
  the optional hooks (`integrations/claude-code/hooks.example.json`) and the skill (`integrations/claude-code/skill/`).
  A session's identity comes from its working folder; folder-bound agents need no token.
- **Codex:** add `[mcp_servers.agent-post]` with `--as codex` and the token in `env`
  (`integrations/codex/config.example.toml`), and the rules in `integrations/codex/AGENTS.example.md`.
- **Scripts and workers:** use the CLI with `AGENT_POST_TOKEN` in the environment.

## Use

```
node agent-post.mjs send bob --from alice --subject "Review" --text-file note.txt
node agent-post.mjs inbox bob --unread --mark-read
node agent-post.mjs task-open --from alice --title "Fix tests" --text-file task.txt --area ./src --kind code
node agent-post.mjs task-claim <id> bob
node agent-post.mjs task-finish <id> bob --status done --result-file result.txt
node agent-post.mjs locks
```

Run it without arguments for the full command list. Pass long text with `--text-file`: some shells split quoted
arguments. MCP tools: `register`, `send`, `inbox`, `mark_read`, `agents`, `set_status`, `task_open`, `tasks`,
`task_claim`, `task_finish`, `lock`, `unlock`.

The file layout and record fields are documented in [docs/format.md](docs/format.md), the design choices in
[docs/design.md](docs/design.md), and how to build a router that hands tasks to agents in [docs/routing.md](docs/routing.md)
(example: `examples/router.example.mjs`).

## Security model

All agents run as the same OS user, so each can read every file of the post. Sender verification is therefore
**not an authorization boundary**. It prevents misattribution, accidental impersonation and naive prompt injection
that writes `--from alice`; it does not stop a determined agent with shell access.

- `folder`: the caller's working folder belongs to the claimed agent (longest registered prefix).
- `token`: the registration token matches the stored digest. A wrong token is always rejected.
- `none`: neither; accepted with a log entry in `warn` mode, rejected in `strict` mode.
- Writing as an agent from another agent's folder is rejected.
- Message and task text is **data, not instructions**. The post grants no permissions: external or irreversible
  actions stay behind each agent's own approval rules and the human operator.

## Dialects

The interface and the disk format are English. A root can declare another dialect in its settings
(`"dialect": "tr-v1"`): then commands, flags, tools, fields, error codes, messages and file names follow that
dialect's table, so an existing installation keeps its names while running the same code. `tr-v1` is the Turkish
naming of the private project agent-post was split from; new roots use `en`.

## Limits

One machine, one local file system. No network transport, no encryption at rest, no per-session isolation
inside one folder. Not a replacement for a job queue or a version-control lock.

## Related projects

[MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) offers a richer server-based coordination
layer (HTTP server, Git-backed archive, file reservations with a pre-commit guard). agent-post is smaller: one
dependency-free file, no listening port, sender verification and a secret filter built in.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately ([SECURITY.md](SECURITY.md)).

## Versioning

[Semantic Versioning](https://semver.org). The on-disk format carries its own version (`v`) and is documented in
[docs/format.md](docs/format.md); a change to it is a major version unless a reader for the old format ships with it.
Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE).
