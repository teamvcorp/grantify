import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getAnthropic, GRANT_OS_MODEL, textFromMessage } from '@/lib/anthropic'
import { grants, grantForms } from '@/lib/collections'
import { completedPct, formToClient } from '@/lib/forms'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { getActiveInstructions, getCompanyContext, instructionsBlock } from '@/lib/org-ai'

/**
 * POST /api/ai/polish-field — clean up one user-written field answer using the
 * org's active instructions + company info, aligned to the grant's funder.
 * Truthful: rewrites tone/clarity/positioning only, never invents facts.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const BodySchema = z.object({ grant_id: z.string().min(1), field_id: z.string().min(1) })

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
      return NextResponse.json({ error: 'A valid grant_id and field_id are required.' }, { status: 400 })
    }

    const orgId = new ObjectId(session.user.org_id)
    const grantId = new ObjectId(parsed.data.grant_id)

    const grantsCol = await grants()
    const grant = await grantsCol.findOne({ _id: grantId, org_id: orgId })
    if (!grant) return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })

    const formsCol = await grantForms()
    const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
    if (!form) return NextResponse.json({ error: 'No form for this grant yet.' }, { status: 404 })

    const field = form.fields.find((f) => f.id === parsed.data.field_id)
    if (!field) return NextResponse.json({ error: 'Field not found.' }, { status: 404 })
    if (!field.answer || !field.answer.trim()) {
      return NextResponse.json({ error: 'Write an answer before polishing it.' }, { status: 400 })
    }

    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const instructions = await getActiveInstructions(orgId)
    const company = await getCompanyContext(orgId)
    const prompt = `Clean up and strengthen this grant application answer. Improve clarity, tone, and persuasiveness, and align it to the funder — but stay strictly truthful: use only the facts in the current answer and the organization info below. Do NOT invent facts, figures, names, or outcomes. Return ONLY the rewritten answer text — no preamble, no quotes, no markdown.
${instructionsBlock(instructions)}
GRANT: ${grant.name} — ${grant.funder} (${grant.funder_type})
${grant.requirements_raw ? `\nWHAT THE FUNDER FUNDS:\n${grant.requirements_raw}\n` : ''}${
      company ? `\nORGANIZATION INFO (factual reference):\n${company}\n` : ''
    }
FIELD QUESTION: ${field.question}

CURRENT ANSWER:
${field.answer}`

    let polished: string
    try {
      const client = getAnthropic()
      const response = await client.messages.create({
        model: GRANT_OS_MODEL,
        max_tokens: 2000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      })
      await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
      polished = textFromMessage(response).trim()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Polish failed.'
      return NextResponse.json({ error: message }, { status: 502 })
    }

    if (!polished) {
      return NextResponse.json({ error: 'No polished text returned.' }, { status: 502 })
    }

    // Save the polished answer (team-owned) back to the field.
    form.fields = form.fields.map((f) =>
      f.id === field.id ? { ...f, answer: polished, source: 'team' as const } : f
    )
    await formsCol.updateOne(
      { grant_id: grantId, org_id: orgId },
      { $set: { fields: form.fields, completed_pct: completedPct(form.fields), last_updated: new Date() } }
    )

    return NextResponse.json({ field_id: field.id, answer: polished, form: formToClient({ ...form }) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Polish failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
