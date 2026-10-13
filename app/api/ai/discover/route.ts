import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  requestBaseFor,
  WEB_SEARCH_TOOL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { purposes } from '@/lib/collections'
import { instructionsBlock } from '@/lib/org-ai'
import { hasCredits, chargeUsage } from '@/lib/credits'
import {
  Candidate,
  FunderLead,
  MAX_CANDIDATES,
  loadExistingKeys,
  loadOrgContext,
  normalizeUrl,
  nameKey,
} from '@/lib/discovery'

/**
 * POST /api/ai/discover — PHASE 1 of AI discovery: find candidate leads.
 *
 * Claude searches the web for NON-federal opportunities (foundation, state,
 * corporate, other) matching one Purpose and returns a short list of leads.
 * It does NOT verify them — that's phase 2, POST /api/ai/discover/verify, one
 * request per candidate.
 *
 * WHY SPLIT: this route used to search AND fetch-verify every candidate in one
 * request. On Vercel Pro (300s cap) that ran past the limit and the platform
 * killed the function — a raw 504 with a non-JSON body, and every result lost.
 * Search-only is fast, and each verification is now its own short request, so
 * results arrive one at a time and a timeout costs one candidate, not the run.
 *
 * SECURITY / multi-tenancy: the Purpose and org context are loaded filtered by
 * the caller's org_id, never by id alone. Server-only; the key never ships.
 */

export const runtime = 'nodejs'
// Search-only, so this should land well inside the limit; the headroom is for
// a slow search turn, not for verification work (that lives in phase 2).
export const maxDuration = 300

const BodySchema = z.object({ purpose_id: z.string().min(1) })

const Candidates = z.array(Candidate)

/**
 * Phase 1 now returns TWO things, because a specific open opportunity is a
 * high bar that most funder pages genuinely cannot meet:
 *  - candidates: specific programs worth verifying.
 *  - funders:    organizations KNOWN to run grant programs, to work through by
 *                hand and revisit annually. No deadline required, so this list
 *                stays useful even when nothing is open today.
 * `.catch` on each half means a malformed one does not lose the other.
 */
const SearchResult = z.object({
  candidates: Candidates.default([]).catch([]),
  funders: z.array(FunderLead).default([]).catch([]),
})

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

METHOD (do this for real — do not skip): use web_search to find real, currently-open programs that match the purpose. Each result must be a program you actually saw in search results. Do NOT invent funders or URLs, and do NOT guess a URL pattern.

URL RULES (important):
- The URL must be on the FUNDER'S OWN WEBSITE. Never return a grant-aggregator or listing site (for example instrumentl.com, grantwatch.com, grants.gov listings, foundation directories, news articles or blog round-ups) — if that is the only place you saw it, search again for the funder's own page, and drop the candidate if you cannot find one.
- Prefer the specific program/application page over the funder's homepage.
- "funder" must be the organization that actually gives the money, matching the site the URL points to. If the page belongs to a different organization than the funder you named, you have the wrong URL.

This is a SHORTLISTING pass only — another step will open each page and verify the details, so do NOT try to confirm deadlines or eligibility now. Be fast.

BE GENEROUS, NOT STRICT. A later step opens each page and records exactly what it says, and the user decides what to pursue — so your job is COVERAGE, not filtering. Include a program even if you are unsure it is open right now: most foundation grants are annual, and knowing a funder exists is useful months before their next round. Returning nothing is the worst possible answer.

Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY these two keys:
{
  "candidates": [   // up to ${MAX_CANDIDATES} SPECIFIC programs worth checking in detail
    {
      "name": string,    // the grant/program name
      "funder": string,  // the organization giving the money
      "url": string      // the program or application page you found
    }
  ],
  "funders": [      // up to 12 organizations KNOWN to run grant programs for this kind of work
    {
      "funder": string,       // company, foundation or agency name
      "url": string,          // their grants/giving page on their OWN site
      "focus": string,        // what they fund, in their words where possible
      "cycle": string,        // e.g. "opens each December", "rolling", "unknown"
      "funder_type": "federal" | "foundation" | "state" | "corporate" | "other"
    }
  ]
}

The "funders" list is a research list the user will work through by hand, so cast a WIDER net there: well-known corporate giving programs, community foundations serving this geography, and family foundations active in this field all belong in it, even with no open opportunity and no posted deadline. Never invent a funder or a URL — every entry must be an organization you actually saw.`
}

export async function POST(req: Request) {
  // One outer try so EVERY failure path returns JSON — never an unhandled 500.
  try {
    const session = await auth()
    if (!session?.user?.org_id) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }

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

    const orgId = new ObjectId(session.user.org_id)
    const purposesCol = await purposes()
    const purpose = await purposesCol.findOne({
      _id: new ObjectId(parsed.data.purpose_id),
      org_id: orgId, // ORG-SCOPED — never by id alone
    })
    if (!purpose) {
      return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
    }

    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const [org, existingKeys] = await Promise.all([
      loadOrgContext(orgId),
      loadExistingKeys(orgId),
    ])

    const client = getAnthropic()
    const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
      { role: 'user', content: buildPrompt(purpose, org) },
    ]
    // Model + thinking + effort for THIS task (see lib/anthropic.ts).
    const base = requestBaseFor('discover')
    const createParams = {
      ...base,
      max_tokens: 4000,
      // Thinking off: this is a fast shortlisting pass. The prompt's explicit
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 5 }],
      messages,
    }

    let response = await client.messages.create(createParams)
    await chargeUsage(orgId, base.model, response.usage)

    // Server tools can pause the turn. The resume MUST carry the container id —
    // the dynamic-filtering web tools run code execution in a container, and
    // omitting it fails the resume with "container_id is required...".
    let guard = 0
    while (response.stop_reason === 'pause_turn' && guard++ < 8) {
      const containerId = response.container?.id ?? null
      messages.push({ role: 'assistant', content: response.content })
      response = await client.messages.create({
        ...createParams,
        ...(containerId ? { container: containerId } : {}),
      })
      await chargeUsage(orgId, base.model, response.usage)
    }
    if (response.stop_reason === 'pause_turn') {
      return NextResponse.json(
        { error: 'The search ran longer than expected. Try again, or narrow the purpose.' },
        { status: 504 }
      )
    }

    const raw = parseJsonFromText<unknown>(textFromMessage(response))
    // Tolerate the model returning a bare array (the old shape) as well as the
    // documented object, so a formatting slip never costs the whole run.
    const parsedResult = Array.isArray(raw)
      ? { candidates: Candidates.catch([]).parse(raw), funders: [] }
      : SearchResult.parse(raw)
    const validated = parsedResult.candidates

    // Drop anything already in the pipeline, and dedupe within the batch, BEFORE
    // spending a verification request on it.
    const seen = new Set<string>()
    const candidates: Candidate[] = []
    for (const c of validated) {
      const uKey = normalizeUrl(c.url)
      const nKey = nameKey(c.funder, c.name)
      if (seen.has(uKey) || seen.has(nKey)) continue
      if (existingKeys.has(uKey) || existingKeys.has(nKey)) continue
      seen.add(uKey)
      seen.add(nKey)
      candidates.push(c)
      if (candidates.length >= MAX_CANDIDATES) break
    }

    return NextResponse.json({
      purpose_id: parsed.data.purpose_id,
      candidates,
      // Leads only — the client verifies each one via /api/ai/discover/verify.
      skipped_count: validated.length - candidates.length,
      // Funders to check by hand — useful even when nothing is open today.
      funders: parsedResult.funders,
    })
  } catch (err) {
    console.error('[ai/discover] failed:', err)
    const raw = err instanceof Error ? err.message : ''
    // Never hand the raw upstream body to the browser: the Anthropic SDK formats
    // APIError.message as `<status> <raw JSON body>`, which is unreadable in the
    // UI and leaks internals. Messages we author ourselves pass through.
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody
        ? 'Grant search failed. Please try again — if it keeps failing, contact support.'
        : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
