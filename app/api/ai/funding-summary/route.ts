import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getAnthropic, GRANT_OS_MODEL, textFromMessage } from '@/lib/anthropic'
import { grants } from '@/lib/collections'
import { fetchGrantsGovOpportunity } from '@/lib/grantsgov'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { getActiveInstructions, instructionsBlock, PLAIN_TEXT_RULE } from '@/lib/org-ai'

/**
 * POST /api/ai/funding-summary
 * Summarize what a funder funds by READING the grant's own guidelines — the
 * live Grants.gov opportunity details for federal grants, otherwise the stored
 * requirements/notes. No web search (that was slow and could hang); this is a
 * single fast summarization. Saves to the grant's `requirements_raw`.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

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

    // Gather the grant's own guideline text. Federal grants have authoritative
    // detail on Grants.gov — fetch it (one fast API call, not web search).
    let sourceText = [grant.requirements_raw, grant.notes].filter(Boolean).join('\n\n').trim()
    if (grant.grantsgov_id) {
      try {
        const opp = await fetchGrantsGovOpportunity(grant.grantsgov_id)
        const detail = JSON.stringify(opp).slice(0, 12000)
        sourceText = `${sourceText ? sourceText + '\n\n' : ''}GRANTS.GOV OPPORTUNITY DATA:\n${detail}`
      } catch {
        // Grants.gov hiccup — fall back to whatever we already have.
      }
    }

    const instructions = await getActiveInstructions(orgId)
    const prompt = `Summarize what this funder funds, reading ONLY the grant guidelines provided below. Do not invent details; if something isn't present, omit it. If the guidelines are sparse, give a brief summary based on the funder name and type without fabricating specifics.
${instructionsBlock(instructions)}
GRANT: ${grant.name}
FUNDER: ${grant.funder} (${grant.funder_type})

Write a concise summary covering:
- What they fund (focus areas, project types, populations served)
- Who is eligible
- What they favor / evaluation priorities, and any notable restrictions

${PLAIN_TEXT_RULE}

GRANT GUIDELINES:
${sourceText || '(no detailed guidelines on file — summarize at a high level from the funder name/type)'}`

    const client = getAnthropic()
    const response = await client.messages.create({
      model: GRANT_OS_MODEL,
      max_tokens: 1500,
      thinking: { type: 'disabled' },
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
