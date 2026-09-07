import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  GRANT_OS_MODEL,
  WEB_FETCH_TOOL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { purposes } from '@/lib/collections'
import { instructionsBlock } from '@/lib/org-ai'
import { hasCredits, chargeUsage } from '@/lib/credits'
import {
  Candidate,
  DiscoveredGrant,
  isFetchableUrl,
  loadExistingKeys,
  loadOrgContext,
  qualifyOne,
} from '@/lib/discovery'

/**
 * POST /api/ai/discover/verify — PHASE 2: verify ONE candidate from phase 1.
 *
 * Opens the candidate's real page with web_fetch, confirms the funder, deadline
 * and eligibility, then applies the server-side qualification gate (live link,
 * deadline rule, eligibility present, not already imported). Returns either the
 * qualified grant or the reason it was excluded.
 *
 * One candidate per request is the whole point: the previous single-request
 * design verified all six inline and blew past Vercel's 300s cap, losing every
 * result. Now each request is small, the client renders results as they land,
 * and a failure costs one candidate instead of the entire run.
 *
 * SECURITY: the candidate comes from the CLIENT, so its URL is untrusted input.
 * `isFetchableUrl` (lib/discovery.ts) blocks non-http(s), localhost and private
 * /link-local addresses before the server ever fetches it — otherwise this would
 * be an SSRF probe. The Purpose and org context stay org-scoped.
 */

export const runtime = 'nodejs'
// One page fetch plus one short model turn — far inside the limit by design.
export const maxDuration = 120

const BodySchema = z.object({
  purpose_id: z.string().min(1),
  candidate: Candidate,
})

function buildPrompt(
  candidate: Candidate,
  p: { name: string; description: string; focus_areas: string[]; geography: string },
  org: { name: string; ein: string; instructions: string; company: string }
): string {
  const companyBlock = org.company
    ? `\nORGANIZATION KNOWLEDGE (facts about this nonprofit — use to judge eligibility):\n${org.company}\n`
    : ''

  return `Verify ONE grant opportunity for a US nonprofit by opening its real page.

APPLICANT ORGANIZATION
- Name: ${org.name}
- EIN: ${org.ein || '(not provided)'}
${instructionsBlock(org.instructions)}${companyBlock}
PURPOSE THIS MUST FIT
- Name: ${p.name}
- Description: ${p.description}
- Focus areas: ${p.focus_areas.join(', ') || '(none specified)'}
- Geography: ${p.geography}

CANDIDATE TO VERIFY
- Name: ${candidate.name}
- Funder: ${candidate.funder}
- URL: ${candidate.url}

METHOD (do this for real — do not skip): use web_fetch to OPEN that URL and read the page. Confirm from the page itself: the funder name, that it is currently open, the deadline (a specific date, OR an explicit statement that applications are rolling / accepted year-round), and the eligibility/requirements. If the page will not load, follow at most one obvious link to the program page.

Return ONLY a JSON object (no prose, no markdown fences).

If you CONFIRMED it, return EXACTLY these keys:
{
  "verified": true,
  "name": string,
  "funder": string,
  "funder_type": "federal" | "foundation" | "state" | "corporate" | "other",
  "amount_min": number | null,        // null only if the funder truly does not publish it
  "amount_max": number | null,
  "deadline_kind": "fixed" | "rolling",
  "deadline": string | null,          // ISO "YYYY-MM-DD" when "fixed"; null when "rolling"
  "url": string,                      // the application/info URL an applicant would use
  "source_url": string,               // the exact page you opened
  "eligibility": string,              // who may apply + key requirements, FROM THE PAGE
  "focus_areas": string[],
  "summary": string                   // 1-2 sentences on fit for this organization
}

If you could NOT confirm it — page won't load, it's closed, the deadline has passed, eligibility is unclear, or this organization is not eligible — return:
{ "verified": false, "reason": string }

Never invent funders, URLs, deadlines, amounts or eligibility. A blank or unknown deadline is NOT acceptable: it must be a real date or an explicitly rolling program.`
}

/** The model answers with one of two shapes; the discriminant is `verified`. */
const VerifyResponse = z.union([
  z.object({ verified: z.literal(true) }).passthrough(),
  z.object({ verified: z.literal(false), reason: z.string().default('could not be confirmed') }),
])

export async function POST(req: Request) {
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
      return NextResponse.json(
        { error: 'A valid purpose_id and candidate are required.' },
        { status: 400 }
      )
    }
    const { candidate } = parsed.data

    // Reject an unfetchable/private-network URL before spending anything on it.
    if (!(await isFetchableUrl(candidate.url))) {
      return NextResponse.json({ verified: false, reason: 'link did not resolve' })
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
      { role: 'user', content: buildPrompt(candidate, purpose, org) },
    ]
    const createParams = {
      model: GRANT_OS_MODEL,
      max_tokens: 3000,
      thinking: { type: 'disabled' as const },
      // Two uses: the candidate page, plus one hop if it redirects to the real
      // program page. Bounded so a single candidate can't run long.
      tools: [{ ...WEB_FETCH_TOOL, max_uses: 2 }],
      messages,
    }

    let response = await client.messages.create(createParams)
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)

    // Resume across server-tool pauses, carrying the container id (see NOTES.md).
    let guard = 0
    while (response.stop_reason === 'pause_turn' && guard++ < 4) {
      const containerId = response.container?.id ?? null
      messages.push({ role: 'assistant', content: response.content })
      response = await client.messages.create({
        ...createParams,
        ...(containerId ? { container: containerId } : {}),
      })
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
    }
    if (response.stop_reason === 'pause_turn') {
      return NextResponse.json({ verified: false, reason: 'verification timed out' })
    }

    // A candidate we can't confirm is a normal outcome, not an error — the
    // client keeps going through the rest of the list either way.
    let raw: unknown
    try {
      raw = parseJsonFromText<unknown>(textFromMessage(response))
    } catch {
      return NextResponse.json({ verified: false, reason: 'no readable answer' })
    }
    const outcome = VerifyResponse.safeParse(raw)
    if (!outcome.success) {
      return NextResponse.json({ verified: false, reason: 'could not be confirmed' })
    }
    if (outcome.data.verified === false) {
      return NextResponse.json({ verified: false, reason: outcome.data.reason })
    }

    const shape = DiscoveredGrant.safeParse(raw)
    if (!shape.success) {
      return NextResponse.json({ verified: false, reason: 'incomplete details' })
    }

    const qualified = await qualifyOne(shape.data, existingKeys)
    if (!qualified.ok) {
      return NextResponse.json({ verified: false, reason: qualified.reason })
    }
    return NextResponse.json({ verified: true, grant: qualified.grant })
  } catch (err) {
    console.error('[ai/discover/verify] failed:', err)
    const raw = err instanceof Error ? err.message : ''
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody ? 'Verification failed. Please try again.' : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
