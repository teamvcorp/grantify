import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  GRANT_OS_MODEL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { grants, grantForms } from '@/lib/collections'
import { completedPct, formToClient } from '@/lib/forms'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { getActiveInstructions, instructionsBlock } from '@/lib/org-ai'
import { logActivity } from '@/lib/activity'
import type { GrantFormField } from '@/lib/types'

/**
 * POST /api/ai/generate-form  — "the secret weapon".
 * Turns a grant's free-text requirements into a structured application form:
 * Claude reads `requirements_raw` (+ name/funder) and proposes the fields an
 * applicant must complete, which we persist as a GrantForm for this grant.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const BodySchema = z.object({ grant_id: z.string().min(1) })

const FIELD_TYPES = ['text', 'textarea', 'select', 'date', 'number', 'file'] as const

// Shape Claude must return per field (we add id/answer/source/kb_match_id).
const GenField = z.object({
  question: z.string().min(1),
  type: z.enum(FIELD_TYPES).default('textarea'),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  section: z.string().default('General'),
  word_limit: z.number().int().positive().nullable().default(null),
  char_limit: z.number().int().positive().nullable().default(null),
  help_text: z.string().default(''),
})
const GenFields = z.array(GenField).max(60)

export async function POST(req: Request) {
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
  if (!grant) {
    return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  }

  const instructions = await getActiveInstructions(orgId)
  const prompt = `You are a grant-application expert. Based on the grant below, produce the list of application fields a nonprofit would need to complete. Group related fields into sections.
${instructionsBlock(instructions)}
GRANT
- Name: ${grant.name}
- Funder: ${grant.funder} (${grant.funder_type})
- Requirements / notes: ${grant.requirements_raw || grant.notes || '(none provided — infer a standard application for this funder type)'}

Return ONLY a JSON array (no prose, no markdown fences) of field objects with EXACTLY these keys:
[{
  "question": string,            // the prompt shown to the applicant
  "type": "text"|"textarea"|"select"|"date"|"number"|"file",
  "options": string[],           // only for "select", else []
  "required": boolean,
  "section": string,             // e.g. "Organization", "Project Narrative", "Budget"
  "word_limit": number | null,
  "char_limit": number | null,
  "help_text": string            // short guidance, may be ""
}]
Aim for the real fields this funder type expects (org info, project narrative, goals/outcomes, budget, etc.). 8–25 fields is typical.
All string values (question, help_text, options) must be plain text — no Markdown, asterisks (**), or backticks.`

  if (!(await hasCredits(orgId))) {
    return NextResponse.json(
      { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
      { status: 402 }
    )
  }

  let genFields: z.infer<typeof GenFields>
  try {
    const client = getAnthropic()
    const response = await client.messages.create({
      model: GRANT_OS_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    await chargeUsage(orgId, GRANT_OS_MODEL, response.usage)
    genFields = GenFields.parse(parseJsonFromText(textFromMessage(response)))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Form generation failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Build persisted fields + the section list (in first-seen order).
  const fields: GrantFormField[] = genFields.map((f) => ({
    id: randomUUID(),
    question: f.question,
    type: f.type,
    options: f.options,
    answer: '',
    source: 'empty',
    kb_match_id: null,
    required: f.required,
    section: f.section,
    word_limit: f.word_limit,
    char_limit: f.char_limit,
    help_text: f.help_text,
  }))
  const sections = [...new Set(fields.map((f) => f.section))]

  const now = new Date()
  const formsCol = await grantForms()
  await formsCol.updateOne(
    { grant_id: grantId, org_id: orgId },
    {
      $set: {
        fields,
        sections,
        generated_at: now,
        last_updated: now,
        completed_pct: completedPct(fields),
      },
      $setOnInsert: { narrative_draft: '', narrative_generated_at: null },
    },
    { upsert: true }
  )

  await logActivity({
    grant_id: grantId,
    org_id: orgId,
    user_id: new ObjectId(session.user.id),
    type: 'form_generated',
    detail: `Generated a ${fields.length}-field application form.`,
  })

  const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
  return NextResponse.json({ form: formToClient(form!) })
}
