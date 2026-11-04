# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- First public version, 0.1.0 (draft). Split in October–November 2026 from a private project where it had been in
  daily use on one machine.
- Inboxes, task board, folder locks, sender verification (`folder | token | none`, `warn` and `strict` modes) and a
  secret filter, as a CLI, an MCP (stdio) server and a Claude Code hook in one dependency-free file.
- `install.mjs` with the agent list in a config file (`--config`).
- English interface and disk format; the `tr-v1` dialect keeps the Turkish names of the original project.
- Example router, Claude Code skill and hooks, Codex configuration, privacy scan script.
