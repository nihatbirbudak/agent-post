# Security

## Supported versions

Only the latest minor release receives fixes.

## Reporting a vulnerability

Please report privately through GitHub's private vulnerability reporting (Security tab › "Report a vulnerability"),
not in a public issue. Include the version, your operating system and steps to reproduce. You will get an answer on a
best-effort basis.

## Threat model in short

agent-post coordinates agents that run as the same operating system user. Every agent can read and write every post
file, so sender verification is **not an authorization boundary**: it prevents misattribution and accidental
impersonation, not a determined local agent. Message and task text is data, not instructions; the post grants no
permissions. See [docs/design.md](docs/design.md) for details.

### Trust boundary

The settings file (`settings.json`) and the registry (`agents.json`, with its backup) are the trusted surface: whoever
can write them can do anything the post can, such as reserve or free a name, protect or unprotect an agent, move a
folder binding or replace a token digest. The rules below therefore guard against a careless or misconfigured agent on
the same machine that uses the CLI or MCP tools; they do not guard against a malicious local user or process with
write access to the post root. Reserved names and protected agents are off until the installer writes them into the
settings; a root without those settings behaves as in 0.1.0 for them.

Identity rules since 0.2.0, all enforced at the CLI and MCP boundary:

- A folder-bound agent is written as only from inside its folder or with its token.
- `status`, `lock` and `unlock` need a verified identity in every mode; `task-claim` verifies like `send`.
- Reserved names (set by the installer) are registered and changed only by the installer and act only with their
  token, from any folder.
- An agent's kind never changes; an MCP server started with `--as` switches only to a free name of its own kind.
- Kind `codex` is kept out of installed Claude agents' folders; a codex-kind inbox opens only to a verified caller.
  Reading or marking an inbox other than a codex agent's is not identity-checked, for reserved names too.
- Protected agents (optional) are reached only by installed, token-verified senders that are not of kind codex.
- A token is never accepted on the command line (`token_flag`); use `AGENT_POST_TOKEN` or the MCP `token` argument.

In scope: ways to make the post record a false verification (`folder` or `token` for a sender that did not prove it),
to make a secret pass the secret filter in a common format, to corrupt records through the public CLI or MCP tools,
to get past one of the identity rules above through the CLI or MCP, or to make the post write outside its root. Out of scope: anything that needs direct write access to the post files.
