# Coding Sessions Portal

A web portal for running coding sessions: members sign in with Google, see the sessions they can attend, record their attendance, and manage their own profile. Administrators manage accounts, groups, attendance and session access.

Live at **<https://coding-sessions-portal.scratchdb.workers.dev>**

## Stack

- Cloudflare Workers for the API runtime.
- Cloudflare Workers Static Assets for the frontend.
- Cloudflare D1 for persistent relational data.
- Google OAuth (PKCE, nonce, state, browser binding) with server-side sessions.
- Node's built-in test runner, running against **real SQLite** via a D1-compatible adapter.
- GitHub Actions for checks and deployment.

The frontend and API share one origin. The UI is plain HTML, CSS and JavaScript with Exo 2 typography and a dark sci-fi identity, plus a complete light theme.

**No Cloudflare R2.** Profile pictures are validated and stored inline in D1 (capped at 350 KB), so the portal runs entirely on free-tier services. A regression test fails the build if any R2 binding or identifier reappears.

## Requirements

- Node.js 24 or later (the tests use `node:sqlite`)
- npm
- A Cloudflare account

## Features

**Members**

- Google sign-in, sign-out, and a profile page with picture, name, email, role, level, XP and a full attendance history.
- Settings for display name, profile picture, light/dark theme, and permanent account deletion.
- Sessions they can attend, with their own attendance status.

**Administrators**

- Account management: role, status, and the reason a member is suspended, which is shown to them when they try to sign in.
- Member emails masked by default, revealed per row and remembered per browser.
- Groups, with members added and removed.
- Sessions created, edited and deleted, with attendance marked per member.
- Sessions locked to specific users and/or groups. Locked sessions are filtered in SQL, so they are simply absent from the response for anyone not entitled to see them.
- Audit log, and a read-only user-preview mode that hides administrator controls without changing any permission.

**Interface**

- No save buttons in the session area: changes apply as you make them.
- Minimised sections, revealed emails and the chosen theme are remembered per browser.
- Responsive down to small screens, with visible focus indicators and semantic markup.

## Local setup

```sh
npm install
npm run check
npm test
npx wrangler d1 migrations apply scratch-portal-db --local
npx wrangler dev
```

## Database

Ten migrations, all additive. `npx wrangler d1 migrations list scratch-portal-db --remote` shows what has been applied.

| Migration | Purpose |
| --- | --- |
| `0001` | users, identities, sessions, audit log, settings |
| `0002`-`0004` | OAuth transactions, browser binding, nonce |
| `0005` | coding sessions and attendance |
| `0006` | detachment rules so deleting an account keeps session history |
| `0007` | `profile_picture_data` |
| `0008` | `portal_groups`, `group_members` |
| `0009` | `session_access`, `session_group_access` |
| `0010` | `status_reason` |

Apply locally with `npm run db:local`, remotely with `npm run db:remote`.

## API

- `GET /api/health`
- `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/auth/blocked`
- `GET /api/profile`
- `GET /api/sessions`
- `GET /api/account`, `PATCH /api/account/profile`
- `PUT` / `DELETE /api/account/profile-picture`
- `DELETE /api/account` - permanent deletion, single transaction
- `GET /api/avatars/:userId` - authenticated, versioned, `private, no-store`
- `/api/admin/*` - administrator only, role re-checked from the database on every request

All state-changing endpoints require the CSRF token, and every SQL statement uses bound parameters.

## Testing

```sh
npm run check
npm test
```

87 tests. The suite applies this repository's own migration files to a real SQLite database through a D1-compatible adapter, so foreign keys, cascades and the account-deletion transaction are genuinely exercised rather than mocked. Fixtures include real PNG, JPEG and GIF bytes and deliberately hostile input.

Not covered by an automated test: the live Google OAuth round trip. That needs real credentials and a browser, and is verified manually.

## Deployment

`deploy.yml` runs on every push to `main`: it installs, runs `npm run check`, runs `npm test`, applies D1 migrations, and only then publishes the Worker. A failing test means Cloudflare is never touched.

It needs two repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Already set. Shown by `npx wrangler whoami`. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard, **My Profile > API Tokens > Create Token**, using the **Edit Cloudflare Workers** template. |

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo EJones35/Coding-Portal
```

Until that token is set, the deploy steps skip and the run reports why. Checks still run either way.

Do not reuse a personal login token for CI. A scoped API token is the whole point of the template.

## Security notes

- Session and CSRF tokens are random, hashed at rest, `HttpOnly`, `Secure`, `SameSite=Lax`, and stored under the `__Host-` prefix.
- OAuth uses PKCE, state, nonce and browser binding; the nonce and state are consumed atomically so a callback cannot be replayed.
- Administrator bootstrap is a one-time claim tied to a verified email, not a request parameter.
- Profile pictures are accepted only on their signature, not their filename or MIME type, so SVG and HTML cannot be stored.
- Account deletion refuses to remove the last active administrator.
- Nothing in this repository contains a credential. `.dev.vars` is gitignored, and OAuth secrets live in Wrangler's secret store.

## Licence and status

An active student project. Achievements and badges are the main planned addition and are not yet implemented; the profile page says so rather than showing placeholders.
