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
- **Model:** `GRANT_OS_MODEL` in `lib/anthropic.ts` (default **`claude-sonnet-5`**, overridable
  via `ANTHROPIC_MODEL`). Any model set here MUST have a price row in `lib/credits.ts`.
  See "Model pin → Sonnet 5" below before switching to Opus 5.
- **Anthropic API:** adaptive thinking (`{type:"adaptive"}`), **stream** long narrative output,
  web search tool `web_search_20260209`. No `budget_tokens`, no `temperature`/`top_p`/`top_k`,
  no assistant prefill on Sonnet 5.
- **Secrets:** real values only in `.env.local` (gitignored). `.env.example` is the committed
  template (allow-listed in `.gitignore` via `!.env.example`).
- **Collection types:** `lib/types.ts` is the single source of truth for document shape.

## Grants.gov integration

- Client: `lib/grantsgov.ts` (Search2 + fetchOpportunity, no key). API ref: `docs/grants-gov-api.md`.
- Route: `POST /api/grants/search` — **auth required**, derives the query from `purpose_id`
  (org-scoped read; still writes nothing). UI: `components/grants/grant-search.tsx`.
  Client-safe code lists live in `lib/grantsgov-codes.ts`. **Read `docs/grants-gov-api.md`
  → QUERY SEMANTICS before touching a query — commas silently return zero results.**
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
- **Grant search pagination**: `components/grants/grant-search.tsx` federal search now sends
  `startRecordNum = page * ROWS` (ROWS=25, 0-based) and renders Prev/Next + "Page X of N" using the
  API's `hitCount`. Previously it only ever requested the first 25 with no controls (the reported
  bug). Grants.gov `startRecordNum` is a 0-based offset; verified live that offsets 0/25/50 return
  distinct pages. `submittedKeyword` pins the query so paging doesn't drift if the input is edited.

- `app/register` — **public self-serve signup** (server action + `useActionState`). Creates a new
  **Org** (plan `free`) + its first user as `admin`, then `signIn('credentials', {redirectTo:'/dashboard'})`.
  Security: scrypt hash; ensures the unique `email` index before insert (race-safe); rolls back the
  org if the user insert hits a duplicate-key; hidden **honeypot** (`company_website`) rejects bots;
  generic errors (email-exists is the only disclosure). `RegisterInput` in schemas.ts. proxy.ts
  redirects logged-in users away from `/register`; landing "Get started"/"Claim your share" →
  `/register`. TODO: IP rate limiting (no infra yet). Team members still come via Settings invite.

## Seed (done)

`scripts/seed.ts`, run via `npm run seed` (= `tsx --env-file=.env.local scripts/seed.ts`).
Idempotent: ensures indexes (unique `users.email`, org-scoped on the rest), upserts the org
(`SEED_ORG_NAME`) + admin (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`), and seeds one example
Purpose + 2 grants + 2 KB entries only if the org has no purposes yet. Needs `tsx` (devDep) —
`node --experimental-strip-types` can't resolve the extensionless `lib/` imports.

## AI discovery (done — first AI route)

- `POST /api/ai/discover` ({purpose_id}) — org-scoped Purpose load, then Claude with **web_search +
  web_fetch** (`GRANT_OS_MODEL`, `thinking:{type:'disabled'}`, `pause_turn` resume loop guard<8,
  `maxDuration = 300`, JSON via `parseJsonFromText`). Finds foundation/state/corporate/**other**
  grants (complements federal Grants.gov). See "Qualified non-federal discovery" below.
- `GET /api/purposes` — list org purposes for the discovery dropdown.

### Qualified non-federal discovery (make AI results match the federal detail bar)

Goal: non-federal results must reach the same detail a federal Grants.gov record guarantees, and
**anything that can't is excluded, not shown** (user constraint). Three changes vs the original:
1. **Org context in the prompt** — `getActiveInstructions` + `getCompanyContext` + org name/EIN
   (`lib/org-ai.ts`) so the model judges *eligibility* for THIS org (previously discovery saw only
   the abstract Purpose — the other 5 AI routes already used org context).
2. **Verify by fetch** — the prompt runs search → then `web_fetch` each candidate's real page to
   confirm funder, deadline, eligibility. Returns `source_url` (page it opened), `deadline_kind`
   ('fixed'|'rolling'), and required `eligibility`. `url` is `z.string().url()`.
3. **Server-side `qualify()` gate** (runs after the Zod parse) EXCLUDES anything that fails the
   contract: url must be http(s) **and pass a liveness check** (`isLive()`: GET, 5s timeout, follow
   redirects; drop only DNS-fail / 404 / 410 — bot-blocked 401/403/405/429 kept); `deadline_kind`
   'fixed' → valid, non-past ISO date, 'rolling' → date null & explicit; `eligibility` non-empty;
   dedup by normalized url + `funder|name` within the batch AND against already-imported grants.
   Response adds `excluded_count`. Cap `MAX_CANDIDATES = 6`.
Client (`grant-search.tsx`): Verified + Rolling badges, eligibility line, "N verified — M excluded".
Import maps `eligibility → requirements_raw` (real requirements feed the form/narrative), and only a
'fixed' deadline maps to `deadline_full`. `'other'` added to `FUNDER_TYPES`/`FunderType`. Web-tool
type strings + pattern saved in `docs/anthropic-web-tools.md`. NOTE: line 40-41's "adaptive thinking"
/ old `maxDuration=60` referred to the pre-verification version — discovery now disables thinking and
uses 300s (still Vercel-Pro-dependent; Hobby's 60s clamp will time out).
- UI: `components/grants/grant-search.tsx` now has a Purpose picker + "Discover with AI" section
  alongside the federal results.

## Purposes CRUD (done)

- `lib/schemas.ts` — `PurposeInput` zod schema + `FUNDER_TYPES`, shared by create/update.
- `GET`/`POST /api/purposes`, `PATCH`/`DELETE /api/purposes/[id]` — all org-scoped. DELETE
  refuses (409) if grants still link to the purpose (no orphans). Next 16 route params are a
  Promise — `const { id } = await params`.
- UI: `components/purposes/purposes-manager.tsx` (list + create/edit Dialog + delete),
  rendered by the Purposes page. Funder types are toggle buttons (no checkbox component exists).

## Grant tracker + dashboard (done)

- `lib/schemas.ts` — `GrantInput` (create/import) + `GrantPatch` (status/phase/notes) + `GRANT_STATUSES`.
- `GET`/`POST /api/grants`, `PATCH`/`DELETE /api/grants/[id]` — org-scoped. POST verifies the
  purpose belongs to the org and dedupes federal imports by `grantsgov_id`. `phase` must be cast
  to `GrantPhase` (zod gives `number`).
- Both federal AND AI-discovered results import via the same POST (only `discovered_by` differs).
- UI: `components/grants/grant-pipeline.tsx` (tracker grouped by status, inline status/phase
  selects, delete) + refactored `grant-search.tsx` (shared "Import into" purpose selector +
  per-row Import buttons). Grants page composes both and bumps a `version` to refresh the pipeline.
- Dashboard (`app/(app)/dashboard/page.tsx`) is now a `force-dynamic` server component computing
  live aggregates (pipeline value, active count, due-in-30, awarded YTD, upcoming deadlines).

## AI form layer + KB + documents + workspace (done)

- KB CRUD: `GET`/`POST /api/kb`, `PATCH`/`DELETE /api/kb/[id]` (embedding_text kept in sync);
  UI `components/kb/kb-manager.tsx` → knowledge-base page.
- AI form layer (all org-scoped, reuse `lib/anthropic` helpers + `lib/forms.ts`):
  - `POST /api/ai/generate-form` — Claude turns `requirements_raw` into GrantForm fields (zod-validated,
    `randomUUID` ids), upserts `grant_forms`. Adaptive thinking, JSON via `parseJsonFromText`.
  - `POST /api/ai/match-kb` — one Claude call maps fields → best KB entry + drafts answers; sets
    `source:'kb'` + `kb_match_id`, bumps KB `times_used`.
  - `POST /api/ai/draft-narrative` — STREAMING (ReadableStream of text deltas, `thinking:disabled`),
    saves `narrative_draft` on completion. Client reads `res.body` reader. `maxDuration=300`.
    Emits `STREAM_DONE` (lib/ui.ts) sentinel on clean finish; accepts `continue_from` to resume a
    cut-off draft (saved = `continue_from + continuation`). Client detects a missing sentinel as a
    timeout → shows a "Narrative didn't finish" banner with **Finish** (`draft(narrative)`) /
    **Restart** (`draft()`). The top "Draft narrative" button must call `() => draft()` (draft takes
    an optional `continueFrom`).
- `GET`/`PATCH /api/grants/[id]/form` (FormPatch: answers[] + narrative_draft) and `GET /api/grants/[id]`.
- Grant workspace: `components/grants/grant-workspace.tsx` at `/grants/[id]` (generate/match/draft +
  editable fields by section + completion % + narrative editor). Pipeline grant names link here.
- Document vault (Vercel Blob): `GET`/`POST /api/documents` (multipart, org-namespaced blob path,
  25MB cap) + `DELETE /api/documents/[id]` (del blob then metadata); UI documents-manager.
- Activity log helper `lib/activity.ts` (logged on form_generated + narrative_drafted).

Lint note: `react-hooks/set-state-in-effect` (React Compiler rule) errors on a synchronous setState
call from an effect — wrap fetch-on-mount as `useEffect(() => { void (async () => { await load() })() }, [])`.

## Settings (done)

- `GET`/`PATCH /api/org` (profile name/EIN — PATCH admin-only; GET also returns caller `role`).
- `GET`/`POST /api/team` (list + add member, admin-only; dup email → 409 via unique index) and
  `PATCH`/`DELETE /api/team/[id]` (role change / remove — admin-only; can't target yourself).
- UI `components/settings/settings-manager.tsx`: org form, team list (inline role select + remove),
  plan/billing panel (Stripe = V2, disabled). Non-admins see read-only.
- `USER_ROLES`/`OrgUpdate`/`MemberInput`/`MemberPatch` in `lib/schemas.ts`.

All six nav items now route to real features. Adding a member sets a temp password the admin shares;
there's no self-serve invite/reset flow yet.

## V2 (done)

- **Budget builder**: `Budget` type + `budgets()` collection; `GET`/`PUT /api/grants/[id]/budget`
  (one doc per grant, full replace); `BudgetInput` schema; `components/grants/budget-panel.tsx`
  (line items + total + notes) in the workspace.
- **Grant-scoped documents**: `/api/documents` POST accepts `grant_id` (scope 'grant', logs
  doc_uploaded); GET takes `?grant_id=`; `grant-documents-panel.tsx` in the workspace. The
  Documents page still shows the whole vault.
- **Activity log UI**: `GET /api/grants/[id]/activity`; `activity-panel.tsx`. Entries written on
  form_generated, narrative_drafted, status_change, doc_uploaded. Workspace bumps `activityKey` to refresh.
- **PDF export**: client-side `exportPdf()` in the workspace opens a print window built from the
  form answers + narrative (no server/lib dependency).
- **Stripe plan gates (scaffold)**: `lib/stripe.ts` (lazy, build-safe, `billingConfigured()`,
  `priceIdFor`), `lib/plan.ts` (`PLANS` + `memberLimit`). Routes `/api/billing/checkout|portal|webhook`
  (webhook reads raw `req.text()` for signature verify; sets `org.plan` from metadata). Member cap is
  the live gate in `/api/team` POST. Settings shows upgrade/portal when configured, else a "add keys"
  note. **Needs real STRIPE_* keys + BASIC_GRANTS_PLAN/PRO_GRANTS_PLAN to function** (in `.env.example`).
- **Password reset (admin)**: `MemberPatch` now accepts `password`; `PATCH /api/team/[id]` hashes it;
  Settings has a per-member key icon. (Self-serve email invite/reset still deferred — no email provider.)

## Email (Resend) — done & live

- `lib/email.ts` — lazy/build-safe Resend client, `emailConfigured()` (needs `RESEND_API_KEY` +
  `RESEND_FROM`), `sendEmail({to,subject,html,replyTo})`. `RESEND_FROM` must be on the
  Resend-verified domain (**fyht4.com**, e.g. `Grant OS <grants@fyht4.com>`).
- `lib/grant-render.ts` — `renderGrantHtml(grant, form, budget)` builds the complete-grant HTML
  (sections + narrative + budget table). Reusable; good base for a future PDF attachment.
- `POST /api/grants/[id]/email` — emails the complete grant; recipient defaults to the signed-in
  user, optional `to` override; `replyTo` = sender. "Email grant" button in the workspace.
- Team add sends a best-effort welcome email (login link only — **never** the password).
- Verified live: a real send from `grants@fyht4.com` succeeded.

## SEO (done) — public domain getgrantify.com

- Public brand is **"Grantify"** (domain getgrantify.com); internal app stays "Grant OS".
- `app/page.tsx` is now a real public, indexable landing page (was a redirect to /dashboard) with
  hero + features + JSON-LD (`SoftwareApplication`). Proxy leaves `/` public.
- `app/layout.tsx` metadata: `metadataBase`, title template, description, keywords, OpenGraph,
  Twitter card, robots index/follow.
- Metadata routes: `app/robots.ts` (allow `/`, disallow app + /api + /login, sitemap+host),
  `app/sitemap.ts`, `app/manifest.ts`, `app/opengraph-image.tsx` (dynamic `next/og` 1200×630 card).
- All verified live (robots.txt, sitemap.xml, manifest.webmanifest, opengraph-image → image/png).
- Landing CTAs use base-ui `<Button render={<Link/>}>` polymorphism.
- **Parent-org association:** Grantify is a project of **The VA Corp** (www.thevacorp.com). Landing
  JSON-LD uses `@graph` with an Organization node (`parentOrganization` + `sameAs` → thevacorp.com)
  + footer "A project of The VA Corp" link. The high-value inbound link FROM thevacorp.com →
  getgrantify.com must be added on that site (it isn't in this repo).

## Stripe webhook (report saved)

- Full setup report: `docs/stripe-setup.md`. Webhook URL `https://www.getgrantify.com/api/billing/webhook`.
- Events the handler acts on: `checkout.session.completed`, `customer.subscription.updated`
  (added — resyncs plan via `planFromPriceId`), `customer.subscription.deleted`.
- Plans: Free $0 / Basic $5 / Pro $25 (`lib/plan.ts`). Price-id env vars: `BASIC_GRANTS_PLAN`,
  `PRO_GRANTS_PLAN` (both set in `.env.local`). Still needs: `STRIPE_WEBHOOK_SECRET`.

## UI / theme (warm emerald lift)

- Design tokens in `app/globals.css` retuned from pure grayscale to **warm stone neutrals (hue ~83)
  + emerald primary (hue ~162)**, light + dark. Everything reads these tokens, so the whole app
  lifted at once. Radius bumped to `0.7rem`. Accent stays neutral-warm (green reserved for primary).
- Brand mark (emerald "G" tile) added to the sidebar header + landing header; OG image gradient →
  emerald. Active sidebar nav item is emerald (`bg-primary`).
- **Catalyst UI kit**: licensed (Tailwind Plus — license held). Raw kit in `catalyst-ui-kit/` is
  **gitignored** + excluded from `tsconfig` (`exclude`) and ESLint (`globalIgnores`) because its
  bundled demo app has unresolved deps (@heroicons, @/data). Deps installed: `@headlessui/react`,
  `motion`, `clsx`. We adopted Catalyst's *design language* via tokens; swapping in actual Catalyst
  *components* (Button/Input/Listbox/Dialog) surface-by-surface is the optional next UI step.
  Reference: `docs/catalyst.md` → https://catalyst.tailwindui.com/docs.
- UI-only change; no core app logic touched. Typecheck + lint clean.

### Catalyst components adopted (round 2)
- Copied into `components/catalyst/` (committed): `button`, `badge`, `input`, `textarea`, `select`,
  `fieldset`, `link` (Link wraps `next/link`). All have `'use client'`. Deps already installed.
- **All native `<select>` → Catalyst `Select`** (styled-native, drop-in; same value/onChange/options):
  grant-search (purpose), grant-pipeline (status/phase), grant-workspace (field-type), kb/documents/
  grant-documents (category), settings (role ×2).
- **All `Badge` → Catalyst `Badge`** with semantic colors via `lib/ui.ts` (`funderColor`, `statusColor`,
  `sourceColor`): funder-type (blue/violet/amber/zinc), KB category + plan (emerald), source (kb=emerald/
  ai=blue), tags/categories (zinc).
- **Login** page: full Catalyst `Field`/`Label`/`Input`/`Button`. **Settings**: Catalyst `Input`/`Select`/
  `Badge`/`Button` (text actions `color="emerald"` / `outline`); icon-only buttons kept as shadcn
  (imported as `IconButton`) since Catalyst Button has no compact icon size.
- Other pages keep shadcn `Button`/`Input` (now emerald-themed) — Catalyst + shadcn coexist fine.

## Knowledge base feedback loop (done)

- **Read:** `/api/ai/match-kb` fills a form from existing entries.
- **Write (manual):** `POST /api/grants/[id]/promote-kb` + "Save answers to knowledge base" button.
- **Write (auto):** grants PATCH auto-promotes when `status → submitted` (best-effort, logs activity).
- Shared upsert lives in `lib/kb-promote.ts` (`promoteFormToKb`) — new question inserts, existing
  question refreshes its answer (idempotent). Heuristic categorizer maps section/question → KbCategory.
- **Purpose tie:** `KnowledgeBaseEntry.purpose_id` (nullable) ties entries to a project. Promotion
  sets it from the grant's purpose; manual KB create/edit has a Project dropdown; entries show a
  violet purpose badge. `KbInput.purpose_id` (string→ObjectId in routes). Seed ties its KB to the
  seeded purpose. Existing entries without the field read as null (safe).

## Submission details + funding summary (done)

- `GrantPatch` extended with `url`, `deadline_loi/full/report` (ISO→Date in PATCH), `requirements_raw`.
  `GET /api/grants/[id]` returns all of them.
- Workspace **"Submission & deadlines"** card: editable LOI/full/report dates with "in N days / overdue"
  labels + "Where to submit" URL with an Open button.
- Workspace **"What they fund"** card: editable funder-intent text (stored in `requirements_raw`) +
  **"Summarize with AI"** → `POST /api/ai/funding-summary`. It **reads the grant's own guidelines**
  (federal → live `fetchGrantsGovOpportunity`; else stored `requirements_raw`/`notes`) and summarizes
  in ONE fast Claude call — **no web search** (that hung/timed out). `maxDuration=60`; client has a
  90s AbortController timeout. `requirements_raw` feeds generate-form + draft-narrative prompts so
  wording aligns with funder intent. AI-discovered imports prefill it from the discovery summary.

## AI usage credits (done)

- `lib/credits.ts` — bills **2× the raw Anthropic cost** of each call against an org credit
  balance (`Org.ai_credits_cents`, cents). Pricing per-token: sonnet-4-6 $3/$15, opus-4-8 $5/$25,
  haiku $1/$5 per 1M; web search ~$0.01/req; cache read 0.1× / write 1.25×. `billedCents`,
  `getCreditCents` (backfills `STARTER_CREDITS_CENTS`=$5 for legacy orgs), `hasCredits`,
  `chargeUsage`, `addCredits`. `CREDIT_PER_REUP_CENTS`=$5.
- Every AI route gates on `hasCredits` (402 when empty) and calls `chargeUsage(orgId, model,
  response.usage)` after each Claude call — discover (per pause_turn iteration), generate-form,
  match-kb, draft-narrative (from `aiStream.finalMessage()`), funding-summary.
- Top-up: `POST /api/billing/credits` (admin, Stripe one-time payment, `TOKEN_REUP_PLAN`, qty 1–50);
  webhook branches on `metadata.type==='credits'` → `addCredits(units × $5)`. Subscription checkout
  unchanged (branch on metadata).
- Dashboard "AI credits" card shows balance + admin BuyCredits (units × $5 → Stripe).
- `TOKEN_REUP_PLAN` in `.env.local` (set) + `.env.example`. Admin org funded to $100 for testing.
- Web search per-request cost is an ESTIMATE — tune `WEB_SEARCH_PER_REQUEST` in `lib/credits.ts`.

## Active AI instructions + per-section polish (done)

- `Org.ai_instructions` — house guidance (voice/strategy/positioning), editable by admins in
  Settings (Organization card). `OrgUpdate.ai_instructions`; `GET /api/org` returns it.
- `lib/org-ai.ts`: `getActiveInstructions(orgId)`, `getCompanyContext(orgId)` (KB Q&A, truncated),
  `instructionsBlock()` prompt helper.
- Injected into prompts: `generate-form`, `funding-summary` (instructions), `draft-narrative`
  (instructions + company info; also told to clean up each section as it writes).
- `POST /api/ai/polish-field` ({grant_id, field_id}) — rewrites one field answer using
  instructions + company info + funder context, truthfully (no invented facts); saves it
  (`source: 'team'`), credit-gated + charged. Per-field **Polish** button on text/textarea fields
  in the workspace (saves first, then polishes, then `setForm`).
- **Letter of intent**: `POST /api/ai/draft-loi` ({grant_id}) — non-streaming, drafts a 1-page LOI
  from the answered fields + instructions + company info; saves `GrantForm.loi_draft`. Workspace
  "Letter of intent" section (generate/edit/save, 90s client timeout). `FormPatch.loi_draft` saves edits.
- **Export completeness**: both PDF export (`exportPdf`) and email (`renderGrantHtml`) include
  LOI + form Q&A + narrative (+ budget on email). The email **attaches the actual supporting-doc
  files**: the route downloads each grant doc from the private blob store (`get(pathname,
  {access:'private'})` → `Buffer`), passes them to Resend via `sendEmail({attachments})`. Total
  capped at 20 MB (Resend's limit is 40 MB); anything over the budget or that fails to fetch is
  skipped and listed under "Too large to attach — request separately". `renderGrantHtml` takes
  `{attached, omitted}` and the email body lists both. (PDF export still lists doc names only.)
- **Billing always shown**: `billingConfigured()` only needs `STRIPE_SECRET_KEY` (set, along with
  BASIC/PRO/TOKEN price ids — only `STRIPE_WEBHOOK_SECRET` is still unset for prod webhooks). The
  Settings "Plan & billing" card no longer shows the "not configured / add these envs" placeholder;
  admins always get the upgrade/manage buttons (the routes 503 with a clear error if a key is ever
  missing).
- **Org logo**: stored as a **data URI** on `Org.logo_url` (NOT a blob — the Blob store is private,
  so a public logo URL isn't available; a data URI embeds cleanly in the print PDF + email). Set in
  Settings → Organization (file→`FileReader.readAsDataURL`, <300KB, image/* only) and saved via the
  existing `OrgUpdate.logo_url` PATCH (zod refines to `data:image/…` or `''`). Rendered in the
  `exportPdf` header, `renderGrantHtml` header (email route passes `org.logo_url`), and returned by
  `GET /api/org`. Note: some email clients strip `data:` `<img>` — logo always renders in the PDF.
- Every AI op is scoped to the actively-worked `grant_id` and includes that grant's funder intent
  (`requirements_raw`) + funder — so the org instruction always applies *with that grant's intent*.
- `PLAIN_TEXT_RULE` (org-ai.ts) is appended to the prose prompts (summary/narrative/polish + a note
  on generate-form) so outputs are plain text — no `**`/Markdown that would render literally in
  PDF/email/form surfaces.

## AI discovery outage: `container_id` on pause_turn resume (fixed 2026-09-07)

**Symptom:** "Discover with AI" failed on the live site with a wall of JSON:
`400 {"type":"error","error":{"type":"invalid_request_error","message":"container_id is
required when there are pending tool uses generated by code execution with tools."}}`.

**Cause:** the `_20260209` web_search/web_fetch tools are the *dynamic-filtering* variants,
which run **code execution** inside an Anthropic-hosted container. When such a turn returns
`stop_reason:'pause_turn'`, its pending tool uses live in that container, so the resume call
must carry the top-level `container` param (the id off the paused response). Our resume loop
re-sent `createParams` verbatim → the API rejected the **resume**, never the first call.
That's why it was intermittent: short runs finish in one turn and never pause; the longer,
more thorough discoveries always died. Latent since the verify-by-fetch work (6cce8ee).

**Fix** (`app/api/ai/discover/route.ts`, the only route using web tools):
1. Capture `response.container?.id` *before* reassigning `response`, and pass it as
   `container` on every resume.
2. If the loop exhausts (`guard` 8) while still `pause_turn`, return a plain 504 instead of
   falling through to a confusing "Could not parse JSON from the AI response."
3. The catch block no longer echoes the upstream error to the browser — the Anthropic SDK
   formats `APIError.message` as `<status> <raw JSON body>`, which is what the user saw.
   Real detail now goes to `console.error` (Vercel function logs); the client gets a generic
   message. Messages we author ourselves still pass through.

Pattern + SDK shapes saved in `docs/anthropic-web-tools.md`. **Any future server-tool loop
must pass the container id** — the same trap applies to code execution generally.

## Model pin → `claude-sonnet-5` (2026-09-07)

Was `claude-sonnet-4-6`. Sonnet 5 reaches roughly the old Opus tier on agentic work at a
lower rate ($2/$10 per 1M vs $3/$15). **It is not a 33% saving:** Sonnet 5 uses the newer
tokenizer (~30% more tokens for the same text), so real spend is roughly a wash. The win is
quality, not cost.

- `max_tokens` raised ~30% on every AI route (discover/narrative/generate-form/match-kb
  8000→12000, loi/polish 2000→3000, funding-summary 1500→2000) so 4.6-era budgets don't
  truncate under the new tokenizer. Output is billed per *actual* token, so headroom is free.
- `lib/credits.ts` **PRICES gained `claude-sonnet-5` ($2/$10) and `claude-opus-5` ($5/$25)**.
  This was a live billing bug waiting to happen: the table only knew 4.6/4.8/haiku and fell
  back to Sonnet 4.6's $3/$15, so any `ANTHROPIC_MODEL` override silently mis-billed.
  `DEFAULT_PRICE` is now the *most expensive* known rate (never silently eat margin) and an
  unknown model logs a warning.
- Breaking changes checked and clear: no `budget_tokens`, no `temperature`/`top_p`/`top_k`,
  no assistant prefill anywhere (the pause_turn `role:'assistant'` push is a resume, legal).
- **Not yet done — Opus 5 blocker.** Five routes run `thinking:{type:'disabled'}` (discover,
  draft-loi, draft-narrative, funding-summary, polish-field). On Opus 5 that combination can
  make the model emit a tool call as *plain text* instead of a `tool_use` block — the turn
  succeeds and the tool never runs, worst on tool-heavy search. Before pinning Opus 5, move
  those to `{type:'adaptive'}` + `output_config.effort` 'low'/'medium'.
- **Prompt re-tuning still owed (`[TUNE]`, not blocking).** Sonnet 5 follows instructions more
  literally, so holdover style directives can over-apply, and with thinking off it is *less*
  tool-eager — discovery's "METHOD (do this for real — do not skip)" block is now load-bearing.
  Worth reviewing narrative/LOI voice against real output before calling the migration done.

## Federal search now uses the Purpose (2026-09-07)

**Reported:** federal results looked "off topic and unrefined".

**Confirmed cause: the federal search never used the Purpose at all.** The route
whitelisted only keyword/oppStatuses/agencies/rows/startRecordNum, and the client sent just the
free-text box; `purposeId` was read *only* for the import payload and AI discovery. Worse, the
client sent `keyword: kw || undefined`, so an EMPTY search box sent no keyword and Grants.gov
returned the first 25 of **all 1024** open opportunities — i.e. random noise.

**What changed**
- `POST /api/grants/search` accepts `purpose_id` and derives the query from that Purpose
  (org-scoped load — never by id alone). It now also **requires a session**: it reads org data,
  and shouldn't be an open proxy. Explicit `keyword` still overrides the derived one.
- `buildFederalQueryFromPurpose` (lib/grantsgov.ts) does the mapping; `applied` comes back in the
  response so the UI shows *why* results appeared instead of refining invisibly.
- Empty search with no purpose/keyword/filters now 400s instead of dumping everything.
- Code lists moved to **`lib/grantsgov-codes.ts`** (pure data, client-safe) so the UI can render
  filter dropdowns without pulling the server-only fetch layer into the browser bundle.
- UI: purpose label changed from "Import into" to "Purpose", eligibility + category dropdowns,
  a "Refined by purpose — …" line, and a one-click "Narrow to <category>" button.

**Everything above is measured against the live API, not assumed** — full evidence tables in
`docs/grants-gov-api.md` → QUERY SEMANTICS. The three that matter:
1. **Comma lists return ZERO.** `'ED'`=146, `'ST'`=315, `'ED,ST'`=**0**. Same for eligibilities
   and oppStatuses. `searchGrantsGov` now throws on a comma rather than silently finding nothing.
2. **Bare multi-word keywords BROADEN** (they OR): `education youth STEM`=485 vs `STEM`=129.
   **Quoting narrows**: `"early childhood"`=24 vs 463. Quoted phrases union exactly (2+22=24).
3. **Auto-applying a funding category is destructive** — 205→6, 87→**0** — because Grants.gov's
   category tagging is sparse. So it is SUGGESTED, never forced.

**Honest limitation (not fixed, can't be from this API):** Grants.gov has **no relevance sort**
(`sortBy:'relevance'` → 0) and matches full text across the entire synopsis, so a research grant
that merely mentions "homelessness" sits alongside a real housing program, in date order. We can
only shrink the match set, not rank it. Optional next step: client-side re-rank of the visible
page by how many focus-area terms hit the title.

## BUG: funding-stats cron has been a no-op since it shipped (fixed 2026-09-07)

Same root cause as #1 above. `app/api/cron/funding-stats/route.ts` queried
`oppStatuses: 'forecasted,posted'`, which returns **0**. So every category stored
`open_count: 0` / `amount: 0`; `getFundingStats()` drops rows with `amount <= 0`, fell back to
`DEFAULT_FUNDING_STATS`, and **the landing hero has been showing hardcoded estimates all along**
while the cron appeared to succeed. Now runs `posted` and `forecasted` as two calls and sums them.
Worth a manual cron trigger to backfill real numbers.

## Status — what's next (still deferred)

1. Token-based self-serve password reset / invite-accept (current reset is admin-set; welcome email
   is a login link only).
2. Atlas Vector Search for KB matching at scale (`embedding_text` reserved).
3. Real Stripe end-to-end verification once keys/prices exist (checkout + webhook).
4. Optional: PDF attachment on the grant email (needs a PDF lib; HTML body works today).
3. Knowledge base CRUD + matching, document vault (Vercel Blob), budget, PDF export, activity log.
4. Stripe scaffold (plan gates) — V2.

## KB matching note (spec ambiguity to resolve)

The spec describes KB matching two ways: "string similarity on question text" AND an
`embedding_text` field implying vector search. Decide before building `/api/ai/match-kb`:
start with Claude-judged semantic match over KB entries (simple, no vector infra), or add
Atlas Vector Search later if recall needs it. `embedding_text` is retained for the latter.
