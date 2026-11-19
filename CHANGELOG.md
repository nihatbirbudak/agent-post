# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org).

## [0.2.0] - 2026-11-19

Fixes found in daily use after the split: a power cut that left the registry as a file of zero bytes, and agents in
one folder that could write under each other's names. The disk format stays version 1; every change to it is
additive, and a 0.1.0 root is read as it is. See "Upgrading from 0.1.0" in the README.

### Fixed

- A power cut right after a write could leave `agents.json` full of zero bytes: `atomicWrite` now forces the data to
  disk (`fsync`) before the rename.
- The registry keeps a backup (`agents.json.bak`, written after every registry write). A registry that cannot be
  parsed or has the wrong shape is read from the backup instead of failing every call; a read error on a sound file
  (permission, busy file) stays a visible `corrupt_file` and never falls back.
- A read from the backup is never silent: it is logged once (`corrupt_file_from_backup`, with both modification times,
  the backup's age and `backup_stale`), and the next MCP answer, CLI call and `UserPromptSubmit` hook carry a warning.
  A shared copy of the warning (`backup-warning.json`) lives for 15 minutes, so a `Stop` hook that repairs the file or
  a background poller cannot use it up. A failed backup write is logged (`backup_not_written`) and does not fail the
  call.
- A JSONL part made only of zero bytes (an append that never reached the disk) is not reported as a corrupt line.
- The default identity of a folder (hook, MCP without `--as`) picked the first agent registered there, so a Claude
  session could take a Codex agent's identity. It is now the folder's only `claude` agent, or the one the installer
  marked `default`, or none (the session names itself with `register`).

### Security

- An agent bound to a folder can no longer be written as from outside that folder, even from a folder that belongs to
  no agent (`identity_mismatch`).
- `status`, `lock` and `unlock` need a verified identity (folder or token) in every mode (`identity_required`);
  `task-claim` verifies the claimer like `send`.
- Reserved names (`"reserved": true` in the install config): only the installer registers them and changes their
  folder and token (`reserved_name`), and acting as one needs its token in every mode, because a folder cannot tell its
  owner from another session working in it. A reserved name registered by someone else first is taken back with a new
  token. A reserved name is marked seen only with its token or from exactly its folder.
- A registered agent's kind never changes (`kind_immutable`). An MCP server started with `--as` keeps its kind: it can
  switch only to a same-kind name that is not reserved and not another session's registration (`identity_fixed`).
- An agent of kind `codex` cannot be bound to an installed Claude agent's folder or a folder inside it
  (`codex_folder_forbidden`; links, short names, `..` and case are resolved). A codex-kind inbox opens only to a
  verified caller (`inbox_identity_required`). Mail and tasks for a folderless Codex session whose post process has
  ended are refused instead of being lost (`recipient_unowned`).
- Protected agents (`"protected": true`, optional, off by default): only installed, token-verified senders that are
  not of kind codex reach them, by message, by task, or by claiming or finishing a task they opened
  (`protected_no_codex`, `protected_needs_install`, `protected_needs_token`); with `protect_unaddressed` also tasks
  without a recipient.
- The `--token` flag is rejected (`token_flag`): other processes can read a command line. Use `AGENT_POST_TOKEN` or the
  MCP `token` argument.

### Changed

- `install.mjs` upgrades a root in place: the config is authoritative for the kind, folder and `default` mark of the
  agents it lists, which become `installed`; agents it does not list are kept, except that a codex record bound to an
  installed Claude agent's folder loses that binding. The installer never marks an agent seen. The report adds
  `corrected`, `taken_back`, `kept`, `unbound`, `reserved` and `protected`.
- MCP `register` stores the session folder only for kind `claude`, and for `codex` only away from an installed Claude
  agent's folder; other kinds stay without a folder.
- New record fields `installed`, `default` and `owner_pid` (agents); new settings `reserved_names`,
  `protected_agents` and `protect_unaddressed`; new files `agents.json.bak` and `backup-warning.json`. In `tr-v1` they
  keep the original project's names (`ajanlar.json.yedek`, `yedek-uyarisi.json`, `kurulum`, `varsayilan`,
  `sahip_pid`, and the same error codes, except the protection gate's `korunana_*` codes, a feature new here).
- `register(…, { install: true })`, `seenFrom`, `codexFolderForbidden`, `unbindFolder`, `setOwner`,
  `reservedNames`, `protectedAgents` and `takeBackupWarning` are exported; `claimTask` takes `{ folder, token }`.

## [0.1.0] - 2026-11-04

### Added

- First public version. Split in October–November 2026 from a private project where it had been in daily use on one
  machine.
- Inboxes, task board, folder locks, sender verification (`folder | token | none`, `warn` and `strict` modes) and a
  secret filter, as a CLI, an MCP (stdio) server and a Claude Code hook in one dependency-free file.
- `install.mjs` with the agent list in a config file (`--config`).
- English interface and disk format; the `tr-v1` dialect keeps the Turkish names of the original project.
- Example router, Claude Code skill and hooks, Codex configuration, privacy scan script.

