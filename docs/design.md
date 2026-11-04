# Design notes

## Why plain files

Agents on one computer already share a disk; they do not share a process, a network port or an account. Files need
no daemon to keep alive, survive restarts, can be inspected with any editor and are easy to back up. Every agent
reads its inbox in its own turn, so a busy or paused session never blocks a sender.

## Why `wx` lock files

Creating a file with the `wx` flag is atomic on every common file system and needs no native module. A lock file
holds a random owner token; release removes the file only if the token is still ours, so a lock that expired and was
taken by another process is never removed by its old owner. Stale locks (crashed owners) are removed after 30
seconds, but only under a second short lock and only after checking the content is still the same stale lock: a fresh
lock that appears in between is neither removed nor moved.

Appends check the last byte first: if an earlier writer stopped in the middle of a line, the new record starts on its
own line, so one broken write costs one line, never two.

## Why atomic rename

Whole-file records (registry, tasks, locks, settings) are written to a temporary file and renamed over the target.
On Windows a rename can fail briefly while another process reads the file; the write retries for up to half a second.

## Why a token digest

A registration token proves an identity for agents that have no folder of their own (a Codex instance, a script). The
registry keeps only the SHA-256 digest, so reading the registry does not reveal tokens, and comparison is
constant-time. A token is shown once, when it is issued.

## Threat model

All agents run as the same OS user and can read and write every post file. agent-post therefore does not try to be an
authorization boundary. It defends against:

- **misattribution:** a message always says how its sender was verified (`folder`, `token`, `none`);
- **accidental impersonation:** an agent cannot write as another agent from that agent's folder;
- **naive injection:** text that tells an agent to run `--from alice` from the wrong folder is rejected;
- **secret leaks into the post:** the secret filter rejects common key, token and password formats.

It does not defend against an agent that edits the files directly, reads another agent's token from its
configuration, or changes its working folder on purpose. Message and task text is data: the post grants no
permissions, and external or irreversible actions stay behind each agent's own approval rules.

## Dialects

The core works with English names internally. A dialect is a table that maps every outside name (commands, flags,
MCP tools, record fields, enum values, error codes, messages, environment variables, file names) from English. A root
declares its dialect in its settings; a root without a declaration takes the dialect whose files it already has. The
table is applied at the boundary only (disk, CLI, MCP), so one code base serves both, and every test runs in every
dialect. An English name is not accepted where a dialect spells it differently, so a dialect is never a silent
superset of another.

## Not included

No network transport, no plugin loading, no background service. A router that hands tasks to agents is an ordinary
agent built on the CLI or MCP (see [routing.md](routing.md)); keeping it outside the core keeps the attack surface
small.
