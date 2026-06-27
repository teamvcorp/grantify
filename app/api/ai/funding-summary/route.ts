import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getAnthropic, GRANT_OS_MODEL, WEB_SEARCH_TOOL, textFromMessage } from '@/lib/anthropic'
import { grants } from '@/lib/collections'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { getActiveInstructions, instructionsBlock } from '@/lib/org-ai'

/**
 * POST /api/ai/funding-summary
 * Summarize what a funder actually funds (priorities, eligibility, what they
 * favor) via web search, so the team can align wording with the funder's intent.
 * Saves the summary to the grant's `requirements_raw` (which the AI form and
 * narrative also read). Thinking disabled + few searches to stay under the limit.
 */
export const runtime = 'nodejs'
export const maxDuration = 300

const BodySchema = z.object({ grant_id: z.string().min(1) })

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
    if (!parsed.success || !ObjectId.isValid(parsed.data.grant_id)) {
      return NextResponse.json({ error: 'A valid grant_id is required.' }, { status: 400 })
    }

    const orgId = new ObjectId(session.user.org_id)
    const grantId = new ObjectId(parsed.data.grant_id)
    const grantsCol = await grants()
    const grant = await grantsCol.findOne({ _id: grantId, org_id: orgId })
    if (!grant) return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })

    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const instructions = await getActiveInstructions(orgId)
    const prompt = `Research this grant and summarize what the funder actually funds, so an applicant can align their proposal with the funder's intent.
${instructionsBlock(instructions)}
GRANT: ${grant.name}
FUNDER: ${grant.funder} (${grant.funder_type})
${grant.url ? `URL: ${grant.url}` : ''}

Use web search to find the funder's stated priorities. Write a concise summary (no preamble) covering:
- What they fund (focus areas, project types, populations served)
- Who is eligible
- What they favor / evaluation priorities, and any notable restrictions

Keep it tight and factual — short paragraphs or bullet points. Do not invent details; if something isn't found, omit it.`

    const client = getAnthropic()
    const response = await client.messages.create({
      model: GRANT_OS_MODEL,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 2 }],
      messages: [{ role: 'user', content: prompt }],
    })
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)

    const summary = textFromMessage(response).trim()
    await grantsCol.updateOne(
      { _id: grantId, org_id: orgId },
      { $set: { requirements_raw: summary, updated_at: new Date() } }
    )

    return NextResponse.json({ summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not summarize funding.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
