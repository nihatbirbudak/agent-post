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

In scope: ways to make the post record a false verification (`folder` or `token` for a sender that did not prove it),
to make a secret pass the secret filter in a common format, to corrupt records through the public CLI or MCP tools,
or to make the post write outside its root. Out of scope: anything that needs direct write access to the post files.
