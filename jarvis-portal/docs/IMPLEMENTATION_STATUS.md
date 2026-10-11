# Implementation status

## Stage 1 — Foundation

- [x] Repository structure established
- [x] Static frontend and responsive dashboard shell
- [x] Worker API health endpoint
- [x] Initial D1 schema migration
- [x] Unit tests for current API behaviour
- [x] GitHub Actions workflow
- [x] README with local setup and deployment outline
- [ ] Create and configure the real Cloudflare D1 database
- [ ] Install dependencies and verify Wrangler build/development environment
- [ ] Deploy to Cloudflare and perform remote smoke tests

## Not implemented yet

Google OAuth, Discord OAuth, administrator bootstrap, account linking, persistent login sessions, profile management, R2 uploads, groups, sessions, attendance, achievements, XP/levels, admin interface, exports and end-to-end tests.

## Verification record

The initial source-level tests are intended to run with `npm test`; results must be recorded from actual execution before this stage is marked verified. Live OAuth and deployment tests require configured external services and credentials.
