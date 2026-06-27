import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getAnthropic, GRANT_OS_MODEL, textFromMessage } from '@/lib/anthropic'
import { grants, grantForms } from '@/lib/collections'
import { hasCredits, chargeUsage } from '@/lib/credits'
import {
  getActiveInstructions,
  getCompanyContext,
  instructionsBlock,
  PLAIN_TEXT_RULE,
} from '@/lib/org-ai'

/**
 * POST /api/ai/draft-loi
 * Draft a Letter of Intent for the funder from the completed form answers —
 * the daunting part for novice grant writers. Short, non-streaming, grounded
 * in the answers + org info. Saves to the GrantForm's loi_draft.
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

    const formsCol = await grantForms()
    const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
    if (!form) return NextResponse.json({ error: 'Generate a form first.' }, { status: 404 })

    const answered = form.fields.filter((f) => f.answer && f.answer.trim())
    if (answered.length === 0) {
      return NextResponse.json(
        { error: 'Fill in some answers first so the letter has something to say.' },
        { status: 400 }
      )
    }

    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const instructions = await getActiveInstructions(orgId)
    const company = await getCompanyContext(orgId)
    const amount =
      grant.amount_max || grant.amount_min
        ? `Requested/available range: $${(grant.amount_min || 0).toLocaleString()} – $${(
            grant.amount_max || 0
          ).toLocaleString()}.`
        : ''

    const prompt = `Write a concise, professional one-page Letter of Intent (LOI) from the organization to the funder for the grant below. An LOI briefly introduces the organization, states the project and the funding being sought, shows alignment with the funder's priorities, and invites the funder to request a full proposal. Use ONLY facts in the answered fields and organization info — do not invent figures, names, or outcomes. Use bracketed placeholders like [Date], [Contact Name], [Title] where specific contact details aren't provided.

${PLAIN_TEXT_RULE}
${instructionsBlock(instructions)}
GRANT: ${grant.name} — ${grant.funder} (${grant.funder_type})
${grant.requirements_raw ? `\nWHAT THE FUNDER FUNDS (align to these):\n${grant.requirements_raw}\n` : ''}${amount ? `\n${amount}\n` : ''}${
      company ? `\nORGANIZATION INFO:\n${company}\n` : ''
    }
ANSWERED APPLICATION FIELDS:
${answered.map((f) => `## ${f.question}\n${f.answer}`).join('\n\n')}

Write the letter now (standard business-letter structure: date, funder address line, salutation, 3–4 short body paragraphs, closing).`

    let loi: string
    try {
      const client = getAnthropic()
      const response = await client.messages.create({
        model: GRANT_OS_MODEL,
        max_tokens: 2000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      })
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
      loi = textFromMessage(response).trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LOI generation failed.'
      return NextResponse.json({ error: message }, { status: 502 })
    }

    await formsCol.updateOne(
      { grant_id: grantId, org_id: orgId },
      { $set: { loi_draft: loi, last_updated: new Date() } }
    )

    return NextResponse.json({ loi })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LOI generation failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
