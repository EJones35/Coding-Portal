# Coding Sessions Portal

Coding Sessions Portal is a website for coding sessions, attendance, profiles and achievements. This repository currently contains **Stage 1: Foundation**. Authentication, profile editing, uploads, groups, sessions, attendance, achievements, XP, levels and administrator workflows are not implemented yet.

## Stack

- Cloudflare Workers for the application/API runtime.
- Cloudflare Workers Static Assets for the frontend.
- Cloudflare D1 for persistent relational data.
- Cloudflare R2 is planned for profile-picture storage in a later stage.
- Node.js built-in test runner for the initial tests.
- GitHub Actions for automated checks.

The frontend and API share one origin. The UI uses HTML, CSS and JavaScript with Exo 2 typography.

## Requirements

- Node.js 22 or later
- npm
- A Cloudflare account for deployment
- Wrangler CLI (installed through the project's development dependency)

## Local setup

```sh
npm install
npm run check
npm test
npx wrangler dev
```

Wrangler serves the local application and API. The D1 binding must be configured for local database work; see the database section below. The current health endpoint does not require database access.

## Database

The first migration creates the core user, external identity, server session, audit log and settings tables. It deliberately does not create an administrator.

Create the database in your Cloudflare account:

```sh
npx wrangler d1 create scratch-portal-db
```

Copy the returned database ID into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Do not commit credentials or secrets. Then apply the migration locally:

```sh
npm run db:local
```

When ready to deploy and after checking the target database, apply remote migrations with:

```sh
npm run db:remote
```

Remote migrations should not be run until the database ID and production environment have been checked.

## API

- `GET /api/health` — returns a small JSON health response.
- Unknown `/api/*` paths return JSON 404 responses.

No authentication endpoints exist in this foundation milestone.

## Testing

```sh
npm run check
npm test
```

The tests currently cover the health endpoint, unsupported methods, unknown API paths and static-asset routing. They do **not** establish that future authentication or administrator security is implemented.

## Deployment

1. Create a Cloudflare D1 database and configure its ID in `wrangler.toml`.
2. Review the free plan's current quotas and your account's billing settings.
3. Install dependencies with `npm ci`.
4. Run syntax checks and tests.
5. Apply the intended D1 migration to the correct environment.
6. Deploy using `npm run deploy`.

No paid plan or automatic paid upgrade is configured by this repository. Keep the Cloudflare account on its Free plan; do not enable paid products to bypass quota limits. Free allowances can change and service limits may cause requests to fail when exceeded.

## Secrets and OAuth

Google/Discord OAuth and administrator bootstrap are planned for Stage 2. No real secrets belong in source control. Production secrets will be added using Wrangler's secret-management commands after the authentication implementation exists. Never treat a browser-supplied email as proof of administrator identity.

## Planned implementation order

1. Foundation (current)
2. Google/Discord authentication, secure sessions, account linking and one-time administrator bootstrap
3. Profiles and R2 image uploads
4. Administrator-managed groups and audience-restricted sessions
5. Attendance and achievements
6. Optional per-user XP and levels
7. Audit UI, exports and complete administration
8. Security, end-to-end and production verification

## Current limitations

This is a development foundation, not a production-ready portal. The only working application function is the API health endpoint and static frontend. Do not use it to store real user data until authentication, authorization, migrations, backup and recovery, and the required security tests are implemented.
