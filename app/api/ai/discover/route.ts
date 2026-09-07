import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  GRANT_OS_MODEL,
  WEB_SEARCH_TOOL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { purposes } from '@/lib/collections'
import { instructionsBlock } from '@/lib/org-ai'
import { hasCredits, chargeUsage } from '@/lib/credits'
import {
  Candidate,
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

METHOD (do this for real — do not skip): use web_search to find real, currently-open programs that match the purpose. Each result must be a program you actually saw in search results, with the funder's own page as the URL. Do NOT invent funders or URLs, and do NOT guess a URL pattern. Prefer the specific program page over a funder's homepage.

This is a SHORTLISTING pass only — another step will open each page and verify the details, so do NOT try to confirm deadlines or eligibility now. Be fast.

Return ONLY a JSON array (no prose, no markdown fences) of up to ${MAX_CANDIDATES} objects with EXACTLY these keys:
[{
  "name": string,    // the grant/program name
  "funder": string,  // the organization giving the money
  "url": string      // the program or application page you found
}]
If you found nothing credible, return an empty array [].`
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
    const createParams = {
      model: GRANT_OS_MODEL,
      max_tokens: 4000,
      // Thinking off: this is a fast shortlisting pass. The prompt's explicit
      // METHOD block is what keeps the model reaching for web_search anyway.
      thinking: { type: 'disabled' as const },
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 5 }],
      messages,
    }

    let response = await client.messages.create(createParams)
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)

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
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
    }
    if (response.stop_reason === 'pause_turn') {
      return NextResponse.json(
        { error: 'The search ran longer than expected. Try again, or narrow the purpose.' },
        { status: 504 }
      )
    }

    const raw = parseJsonFromText<unknown>(textFromMessage(response))
    const validated = Candidates.parse(raw)

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
