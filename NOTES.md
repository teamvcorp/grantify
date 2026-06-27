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
- **Export completeness**: both PDF export (`exportPdf`) and email (`renderGrantHtml`) now include
  LOI + form Q&A + narrative (+ budget on email) + a "Supporting documents" list (names; files are
  attached separately, not embedded). Email route fetches grant docs and passes names.
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
