import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  GRANT_OS_MODEL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { grants, orgs, purposes } from '@/lib/collections'
import {
  getActiveInstructions,
  getCompanyContext,
  instructionsBlock,
} from '@/lib/org-ai'
import { hasCredits, chargeUsage } from '@/lib/credits'

/**
 * POST /api/ai/discover
 * Claude-powered discovery of NON-federal grants (foundation, state, corporate,
 * other), scoped to one Purpose. Grants.gov (see /api/grants/search) covers
 * federal opportunities.
 *
 * QUALIFIED RESULTS: federal records arrive fully-formed (real funder, dates,
 * live grants.gov URL). To match that bar for non-federal funders we (a) give
 * the model the org's identity + eligibility context, (b) have it VERIFY each
 * candidate by fetching the real funder page (web_fetch), and (c) apply a
 * server-side qualification gate that EXCLUDES anything that can't meet the
 * app's minimum detail — a live URL, funder, a deadline (fixed or explicit
 * rolling), and eligibility text. Half-populated guesses are dropped, not shown.
 * See docs/anthropic-web-tools.md and NOTES.md.
 *
 * SECURITY / multi-tenancy: the Purpose + org are loaded filtered by the
 * caller's org_id (from the session), never by id alone. Server-only; the
 * Anthropic key never reaches the client.
 */

export const runtime = 'nodejs'
// Search + per-candidate fetch + reasoning is slow; give the function as much
// headroom as the plan allows (Vercel Pro caps at 300s; Hobby clamps to 60s).
export const maxDuration = 300

/** Up to this many candidates — capped to keep search+fetch within the limit. */
const MAX_CANDIDATES = 6

const BodySchema = z.object({ purpose_id: z.string().min(1) })

/**
 * The QUALIFIED shape we ask Claude to return. Stricter than before:
 * `url` is format-validated, `eligibility` is required, and `deadline_kind`
 * distinguishes a fixed date from an explicitly-rolling program.
 */
const DiscoveredGrant = z.object({
  name: z.string().trim().min(1),
  funder: z.string().trim().min(1),
  funder_type: z.enum(['federal', 'foundation', 'state', 'corporate', 'other']),
  amount_min: z.number().nullable(),
  amount_max: z.number().nullable(),
  deadline_kind: z.enum(['fixed', 'rolling']),
  deadline: z.string().nullable(), // ISO "YYYY-MM-DD" when kind==='fixed', else null
  url: z.string().url(),
  source_url: z.string().url(), // the page the model actually fetched to verify
  eligibility: z.string().trim().min(1),
  focus_areas: z.array(z.string()),
  summary: z.string(),
})
type DiscoveredGrant = z.infer<typeof DiscoveredGrant>
const DiscoveredGrants = z.array(DiscoveredGrant)

function buildPrompt(
  p: {
    name: string
    description: string
    focus_areas: string[]
    geography: string
    target_amount: number
    grant_types: string[]
  },
  org: { name: string; ein: string; instructions: string; company: string }
): string {
  const companyBlock = org.company
    ? `\nORGANIZATION KNOWLEDGE (facts about this nonprofit — use to judge eligibility and fit):\n${org.company}\n`
    : ''

  return `You are a grant research assistant for a US nonprofit. Find CURRENTLY OPEN or recurring grant opportunities that this specific organization is ELIGIBLE for and that fit its funding purpose.

APPLICANT ORGANIZATION
- Name: ${org.name}
- EIN: ${org.ein || '(not provided)'}
${instructionsBlock(org.instructions)}${companyBlock}
PURPOSE
- Name: ${p.name}
- Description: ${p.description}
- Focus areas: ${p.focus_areas.join(', ') || '(none specified)'}
- Geography: ${p.geography} (format: "national", "state:XX", or "city:Name")
- Target amount: $${p.target_amount.toLocaleString()}
- Preferred funder types: ${p.grant_types.join(', ') || 'any'}

SCOPE: Prioritize FOUNDATION, STATE, CORPORATE, and other private funders. Federal grants are covered by a separate Grants.gov search — only include a federal grant if it is an unusually strong match. Respect the geography constraint and the organization's eligibility.

METHOD (do this for real — do not skip):
1. Use web_search to find candidate funders/programs that match the purpose.
2. For EACH candidate, use web_fetch to OPEN its real application or program page and CONFIRM: the funder name, whether it is currently open, the deadline (a specific date, OR an explicit statement that applications are rolling / accepted year-round / always open), and the eligibility/requirements.
3. Keep ONLY opportunities you could open and confirm. If a page will not load, or you cannot confirm the funder, deadline (fixed or explicitly rolling), and eligibility, DROP it. Never invent funders, URLs, deadlines, amounts, or eligibility. A blank/unknown deadline is NOT acceptable — either a real date or an explicit rolling program.

Return ONLY a JSON array (no prose, no markdown fences) of up to ${MAX_CANDIDATES} verified objects with EXACTLY these keys:
[{
  "name": string,
  "funder": string,
  "funder_type": "federal" | "foundation" | "state" | "corporate" | "other",
  "amount_min": number | null,        // null only if the funder truly does not publish it
  "amount_max": number | null,
  "deadline_kind": "fixed" | "rolling",
  "deadline": string | null,          // ISO "YYYY-MM-DD" when deadline_kind is "fixed"; null when "rolling"
  "url": string,                      // the application/info URL an applicant would use
  "source_url": string,               // the exact page you fetched to verify this (often same as url)
  "eligibility": string,              // who may apply + key requirements, from the page you read
  "focus_areas": string[],
  "summary": string                   // 1-2 sentences on fit
}]
If you cannot verify any solid matches, return an empty array [].`
}

/** Normalize a URL for dedup: drop protocol + trailing slashes, lowercase. */
function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** Name+funder dedup key. */
function nameKey(funder: string, name: string): string {
  return `${funder}|${name}`.trim().toLowerCase()
}

/**
 * Server-side liveness backstop — we do NOT trust the model's claim that a URL
 * resolves. A fabricated URL fails DNS/connection (caught → not live); a dead
 * page returns 404/410. Bot-blocked-but-real sites (401/403/405/429) still
 * prove the domain exists, so we keep them. 5s timeout, follows redirects.
 */
async function isLive(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; GrantOS-verifier/1.0; grant discovery link check)',
      },
    })
    return !(res.status === 404 || res.status === 410)
  } catch {
    return false // DNS failure, connection refused, or timeout → unreachable
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Apply the qualification contract. Runs AFTER the Zod shape parse and drops
 * anything that can't meet the app's minimum detail. Returns the kept results
 * (with `deadline` normalized) — the caller derives excluded_count.
 */
async function qualify(
  items: DiscoveredGrant[],
  existingKeys: Set<string>
): Promise<Array<Omit<DiscoveredGrant, 'source_url'>>> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const seen = new Set<string>()

  // Pass 1: cheap synchronous field checks + dedup.
  const candidates: Array<Omit<DiscoveredGrant, 'source_url'>> = []
  for (const g of items) {
    // URL must be http(s) (Zod already checked .url()).
    let parsed: URL
    try {
      parsed = new URL(g.url)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue

    // Deadline rule: fixed → valid, not-past date; rolling → date must be null.
    let deadline: string | null = null
    if (g.deadline_kind === 'fixed') {
      if (!g.deadline) continue
      const d = new Date(g.deadline)
      if (Number.isNaN(d.getTime()) || d < today) continue
      deadline = g.deadline
    }

    // Dedup within the batch and against already-imported grants.
    const uKey = normalizeUrl(g.url)
    const nKey = nameKey(g.funder, g.name)
    if (seen.has(uKey) || seen.has(nKey)) continue
    if (existingKeys.has(uKey) || existingKeys.has(nKey)) continue
    seen.add(uKey)
    seen.add(nKey)

    const { source_url: _src, ...rest } = g
    void _src
    candidates.push({ ...rest, deadline })
  }

  // Pass 2: liveness check in parallel (≤ MAX_CANDIDATES fetches).
  const live = await Promise.all(candidates.map((c) => isLive(c.url)))
  return candidates.filter((_, i) => live[i])
}

export async function POST(req: Request) {
  // One outer try so EVERY failure path returns JSON — never an unhandled 500.
  try {
    // 1. AuthN + tenant context.
    const session = await auth()
    if (!session?.user?.org_id) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }

    // 2. Validate body.
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const parsed = BodySchema.safeParse(body)
    if (!parsed.success || !ObjectId.isValid(parsed.data.purpose_id)) {
      return NextResponse.json({ error: 'A valid purpose_id is required.' }, { status: 400 })
    }

    // 3. Load the Purpose + org — ORG-SCOPED (never by id alone).
    const orgId = new ObjectId(session.user.org_id)
    const purposesCol = await purposes()
    const purpose = await purposesCol.findOne({
      _id: new ObjectId(parsed.data.purpose_id),
      org_id: orgId,
    })
    if (!purpose) {
      return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
    }

    // Credit gate.
    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    // Org identity + eligibility context (so the model can judge fit) and the
    // set of already-imported grants for dedup — loaded in parallel.
    const [orgsCol, grantsCol] = await Promise.all([orgs(), grants()])
    const [org, instructions, company, existing] = await Promise.all([
      orgsCol.findOne({ _id: orgId }),
      getActiveInstructions(orgId),
      getCompanyContext(orgId),
      grantsCol.find({ org_id: orgId }).project({ url: 1, funder: 1, name: 1 }).toArray(),
    ])
    const existingKeys = new Set<string>()
    for (const g of existing) {
      if (g.url) existingKeys.add(normalizeUrl(g.url))
      if (g.funder && g.name) existingKeys.add(nameKey(g.funder, g.name))
    }

    // 4. Ask Claude with web_search + web_fetch, resuming across server-tool pauses.
    const client = getAnthropic()
    const tools = [
      { ...WEB_SEARCH_TOOL, max_uses: 5 },
      { ...WEB_FETCH_TOOL, max_uses: MAX_CANDIDATES },
    ]
    const prompt = buildPrompt(purpose, {
      name: org?.name ?? 'Unknown organization',
      ein: org?.ein ?? '',
      instructions,
      company,
    })
    const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
      { role: 'user', content: prompt },
    ]

    const createParams = {
      model: GRANT_OS_MODEL,
      max_tokens: 12000,
      // Thinking disabled: on top of the web tools it would push the call past
      // the function limit. The search+fetch grounding is what makes this useful.
      thinking: { type: 'disabled' as const },
      tools,
      messages,
    }

    let response = await client.messages.create(createParams)
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)

    // web_search/web_fetch can yield stop_reason "pause_turn"; resume until it
    // finishes. Bounded higher than before because fetch adds turns.
    //
    // CONTAINER (critical): the _20260209 web tools are the dynamic-filtering
    // variants, which run code execution on Anthropic's side inside a container.
    // A paused turn leaves tool uses pending in THAT container, so every resume
    // must name it via the top-level `container` param (the id from the paused
    // response). Omitting it fails the resume with:
    //   400 "container_id is required when there are pending tool uses
    //        generated by code execution with tools."
    // Only the resume is affected — a run that finishes in one turn never pauses,
    // which is why this only broke the longer (more search+fetch) discoveries.
    let guard = 0
    while (response.stop_reason === 'pause_turn' && guard++ < 8) {
      // Read the container id BEFORE `response` is reassigned below.
      const containerId = response.container?.id ?? null
      messages.push({ role: 'assistant', content: response.content })
      response = await client.messages.create({
        ...createParams, // `messages` is the same array, mutated just above
        ...(containerId ? { container: containerId } : {}),
      })
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
    }

    // Still paused after the bound: report it plainly rather than falling
    // through to a confusing "could not parse JSON" from the partial turn.
    if (response.stop_reason === 'pause_turn') {
      return NextResponse.json(
        {
          error:
            'Discovery ran longer than expected and was cut off. Try again, or narrow the purpose.',
        },
        { status: 504 }
      )
    }

    // 5. Parse + qualify. Shape-validate, then drop anything that can't meet the
    //    app's minimum detail (live URL, deadline rule, eligibility, dedup).
    const text = textFromMessage(response)
    const raw = parseJsonFromText<unknown>(text)
    const validated = DiscoveredGrants.parse(raw)
    const results = await qualify(validated, existingKeys)

    return NextResponse.json({
      purpose_id: parsed.data.purpose_id,
      results,
      excluded_count: validated.length - results.length,
    })
  } catch (err) {
    // Always log the real failure server-side (Vercel function logs) — this is
    // the only place the upstream detail is preserved.
    console.error('[ai/discover] failed:', err)

    // Never hand the raw upstream error body to the browser. The Anthropic SDK
    // formats APIError.message as `<status> <raw JSON body>`, which is both
    // unreadable in the UI and leaks internals. Anything that looks like that
    // becomes a generic message; messages we author ourselves pass through.
    const raw = err instanceof Error ? err.message : ''
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody
        ? 'AI discovery failed. Please try again — if it keeps failing, contact support.'
        : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
