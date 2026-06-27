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
import { hasCredits, chargeUsage } from '@/lib/credits'

/**
 * POST /api/ai/discover
 * Claude-powered grant discovery, scoped to one Purpose.
 *
 * Grants.gov (see /api/grants/search) covers FEDERAL opportunities only, so this
 * route asks Claude — with the server-side web_search tool — to find the grants
 * Grants.gov can't: foundation, state, and corporate funders matching the
 * Purpose's focus areas, geography, and target amount.
 *
 * SECURITY / multi-tenancy: the Purpose is loaded filtered by the caller's
 * org_id (from the auth session), never by purpose_id alone — see NOTES.md.
 * Server-only; the Anthropic key never reaches the client.
 */

export const runtime = 'nodejs'
// Web search + model reasoning is slow; give the function as much headroom as
// the Vercel plan allows (Pro caps at 300s; Hobby clamps to 60s).
export const maxDuration = 300

const BodySchema = z.object({ purpose_id: z.string().min(1) })

/** What we ask Claude to return, and what we hand back to the client. */
const DiscoveredGrant = z.object({
  name: z.string(),
  funder: z.string(),
  funder_type: z.enum(['federal', 'foundation', 'state', 'corporate']),
  amount_min: z.number().nullable(),
  amount_max: z.number().nullable(),
  deadline: z.string().nullable(),
  url: z.string(),
  focus_areas: z.array(z.string()),
  summary: z.string(),
})
const DiscoveredGrants = z.array(DiscoveredGrant)

function buildPrompt(p: {
  name: string
  description: string
  focus_areas: string[]
  geography: string
  target_amount: number
  grant_types: string[]
}): string {
  return `You are a grant research assistant for a US nonprofit. Use web search to find CURRENTLY OPEN or recurring grant opportunities that fit this funding purpose.

PURPOSE
- Name: ${p.name}
- Description: ${p.description}
- Focus areas: ${p.focus_areas.join(', ') || '(none specified)'}
- Geography: ${p.geography} (format: "national", "state:XX", or "city:Name")
- Target amount: $${p.target_amount.toLocaleString()}
- Preferred funder types: ${p.grant_types.join(', ') || 'any'}

SCOPE: Prioritize FOUNDATION, STATE, and CORPORATE grants. Federal grants are already covered by a separate Grants.gov search, so only include a federal grant if it is an unusually strong match. Respect the geography constraint.

For each opportunity, verify it via web search and include the real application/info URL you found.

Return ONLY a JSON array (no prose, no markdown fences) of up to 8 objects with EXACTLY these keys:
[{
  "name": string,
  "funder": string,
  "funder_type": "federal" | "foundation" | "state" | "corporate",
  "amount_min": number | null,
  "amount_max": number | null,
  "deadline": string | null,   // ISO date "YYYY-MM-DD" if known, else null
  "url": string,
  "focus_areas": string[],
  "summary": string            // 1-2 sentences on fit and eligibility
}]
If you cannot find solid matches, return an empty array []. Do not invent funders or URLs.`
}

export async function POST(req: Request) {
  // One outer try so EVERY failure path (auth, DB, Anthropic, parsing) returns
  // JSON — never an unhandled 500 with a non-JSON body.
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

    // 3. Load the Purpose — ORG-SCOPED (never by id alone).
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

    // 4. Ask Claude, resuming across any server-tool pauses.
    const client = getAnthropic()
    // Cap searches to keep total latency under the function limit.
    const tools = [{ ...WEB_SEARCH_TOOL, max_uses: 3 }]
    const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
      { role: 'user', content: buildPrompt(purpose) },
    ]

    let response = await client.messages.create({
      model: GRANT_OS_MODEL,
      max_tokens: 8000,
      // Thinking is disabled here: on top of web search it pushed the call past
      // the 60s function limit. Web search alone is what makes discovery useful.
      thinking: { type: 'disabled' },
      tools,
      messages,
    })
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)

    // Server-side tool loop can yield stop_reason: "pause_turn"; resume by
    // re-sending the assistant turn until it finishes (bounded for safety).
    let guard = 0
    while (response.stop_reason === 'pause_turn' && guard++ < 5) {
      messages.push({ role: 'assistant', content: response.content })
      response = await client.messages.create({
        model: GRANT_OS_MODEL,
        max_tokens: 8000,
        thinking: { type: 'disabled' },
        tools,
        messages,
      })
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
    }

    const text = textFromMessage(response)
    const raw = parseJsonFromText<unknown>(text)
    const results = DiscoveredGrants.parse(raw)

    return NextResponse.json({ purpose_id: parsed.data.purpose_id, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI discovery failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
