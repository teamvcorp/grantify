# Grant OS — build notes & conventions

Working reference for decisions made during the build. Keep this current so future
work doesn't re-derive context. (See also `docs/` for saved third-party API specs.)

## Stack reality (vs spec)

The spec said Next.js 14; `create-next-app@latest` installed:

- **Next.js 16**, **React 19**, **Tailwind v4** (CSS-first config — no `tailwind.config.js`)
- **shadcn/ui** (new-york style), components under `components/ui/`
- **TypeScript strict** (default from scaffold)
- MongoDB **direct driver** (no Mongoose), `@anthropic-ai/sdk`, `next-auth@beta` (v5),
  `@vercel/blob`, `zod`, `lucide-react`, `date-fns`

App Router code is compatible; Next 16 is what Vercel ships today. If a dependency
forces a downgrade, pin Next 15 via `create-next-app@15` and re-scaffold.

## Build-safety contract (CRITICAL for Vercel)

The first version is pushed to GitHub and built on Vercel **before** secrets are added.
Therefore **no module may throw at import time when an env var is missing.**

- `lib/mongodb.ts` — client built lazily inside `getDb()`/`getClient()`; throws only at
  call time if `MONGODB_URI` is missing. Dev caches the promise on `globalThis`.
- `lib/anthropic.ts` — client built lazily inside `getAnthropic()`; throws only at call
  time if `ANTHROPIC_API_KEY` is missing. **Server-only** — never import in a client component.
- `lib/grantsgov.ts` — public API, no key, no top-level network calls.

If you add a page/route that reads the DB at render time, it must be **dynamic**
(not statically prerendered) or the build will try to connect. Prefer route handlers
or `export const dynamic = 'force-dynamic'` on DB-backed pages.

## Conventions

- **Multi-tenancy:** every org-scoped query MUST filter by `org_id`. `lib/collections.ts`
  gives typed accessors but does NOT enforce the filter — call sites are responsible.
- **Model:** `GRANT_OS_MODEL` in `lib/anthropic.ts` (default `claude-sonnet-4-6`, overridable
  via `ANTHROPIC_MODEL`). Switch to `claude-opus-4-8` for higher quality.
- **Anthropic API:** adaptive thinking (`{type:"adaptive"}`), **stream** long narrative output,
  web search tool `web_search_20260209`. No `budget_tokens`, no `temperature` on Sonnet 4.6.
- **Secrets:** real values only in `.env.local` (gitignored). `.env.example` is the committed
  template (allow-listed in `.gitignore` via `!.env.example`).
- **Collection types:** `lib/types.ts` is the single source of truth for document shape.

## Grants.gov integration

- Client: `lib/grantsgov.ts` (Search2 + fetchOpportunity, no key). API ref: `docs/grants-gov-api.md`.
- Route: `POST /api/grants/search` (proxy + normalize, no DB). UI: `components/grants/grant-search.tsx`.
- This is an upgrade over the spec's "let Claude web-search for grants" — authoritative
  federal data. Claude discovery can complement it for foundation/state/corporate grants.

## Auth & sessions (done)

- `lib/auth.ts` — NextAuth v5: Credentials (email/password via DB) + Google (only when
  `AUTH_GOOGLE_*` set). JWT sessions; `jwt`/`session` callbacks put `id`/`org_id`/`role`
  on `session.user` (typed in `types/next-auth.d.ts`). Build-safe (no import-time throw).
- `lib/password.ts` — scrypt (Node built-in, no dep). Self-describing hash `scrypt$N$r$p$salt$hash`;
  `verifyPassword` is constant-time and never throws. Used by auth + seed.
- `app/api/auth/[...nextauth]/route.ts` exports the NextAuth handlers.
- `proxy.ts` (Next 16's renamed `middleware`) guards the app/(app) routes, redirects to `/login`.
  API routes are excluded from the matcher — they call `auth()` and return 401 themselves.
- `app/login` — minimal Credentials sign-in (server action + `useActionState`). Sidebar has sign-out.

## Seed (done)

`scripts/seed.ts`, run via `npm run seed` (= `tsx --env-file=.env.local scripts/seed.ts`).
Idempotent: ensures indexes (unique `users.email`, org-scoped on the rest), upserts the org
(`SEED_ORG_NAME`) + admin (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), and seeds one example
Purpose + 2 grants + 2 KB entries only if the org has no purposes yet. Needs `tsx` (devDep) —
`node --experimental-strip-types` can't resolve the extensionless `lib/` imports.

## AI discovery (done — first AI route)

- `POST /api/ai/discover` ({purpose_id}) — org-scoped Purpose load, then Claude + `web_search`
  (`GRANT_OS_MODEL`, adaptive thinking, `pause_turn` resume loop, JSON via `parseJsonFromText`).
  Finds foundation/state/corporate grants (complements federal Grants.gov). `maxDuration = 60`.
- `GET /api/purposes` — list org purposes for the discovery dropdown.
- UI: `components/grants/grant-search.tsx` now has a Purpose picker + "Discover with AI" section
  alongside the federal results.

## Status — what's next

1. Purposes CRUD UI + DB-backed dashboard aggregates + Grant tracker/workspace.
2. Remaining AI routes: `/generate-form`, `/match-kb`, `/draft-narrative` (streaming).
3. Knowledge base CRUD + matching, document vault (Vercel Blob), budget, PDF export, activity log.
4. Stripe scaffold (plan gates) — V2.

## KB matching note (spec ambiguity to resolve)

The spec describes KB matching two ways: "string similarity on question text" AND an
`embedding_text` field implying vector search. Decide before building `/api/ai/match-kb`:
start with Claude-judged semantic match over KB entries (simple, no vector infra), or add
Atlas Vector Search later if recall needs it. `embedding_text` is retained for the latter.
