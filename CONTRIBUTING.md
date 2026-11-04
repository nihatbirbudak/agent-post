# Contributing

Issues and pull requests are welcome, in English or Turkish. The project is maintained on a best-effort basis: there
is no promised response time.

## Development

- Node.js 20 or newer. The package has no runtime dependencies; please keep it that way.
- Run the tests: `node --test` (every behavior test runs in every dialect).
- Run the linter: `npm install` once, then `npm run lint`.
- Before a pull request, run the privacy scan: `node scripts/privacy-scan.mjs` (add `--term` for names you want to
  keep out, such as your own).

## Changes

- One topic per pull request, with a test for each behavior change.
- A change to the on-disk format updates `docs/format.md` and either ships a reader for the old format or is a major
  version (see the Versioning section of the README).
- A new outside name (command, flag, tool, field, error code) needs an entry in every dialect table; the dialect
  contract test must keep passing.
- Never put real tokens, keys or passwords in tests; build fake ones at run time (`fake(...)` in `test/helpers.mjs`).

## Reporting bugs

Open an issue with your Node.js version, operating system, the command you ran and what you expected. Remove any
private paths or names from logs first. Security issues go through the private channel in [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the MIT License of this project, and you follow
the [Code of Conduct](CODE_OF_CONDUCT.md).
