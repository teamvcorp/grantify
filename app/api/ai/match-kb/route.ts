import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  GRANT_OS_MODEL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { grantForms, knowledgeBase } from '@/lib/collections'
import { completedPct, formToClient } from '@/lib/forms'

/**
 * POST /api/ai/match-kb
 * For each field of a grant's form, ask Claude to pick the best Knowledge Base
 * entry (semantic match — no vector infra yet, see NOTES.md) and draft an answer
 * from it. Matched fields become `source: "kb"` with the KB id recorded.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const BodySchema = z.object({ grant_id: z.string().min(1) })

const Match = z.object({
  field_id: z.string(),
  kb_id: z.string().nullable(),
  answer: z.string(),
})
const Matches = z.array(Match)

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

  const formsCol = await grantForms()
  const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
  if (!form) {
    return NextResponse.json({ error: 'Generate a form first.' }, { status: 404 })
  }

  const kbCol = await knowledgeBase()
  const kb = await kbCol.find({ org_id: orgId }).toArray()
  if (kb.length === 0) {
    return NextResponse.json(
      { error: 'Your knowledge base is empty — add entries first.' },
      { status: 400 }
    )
  }

  const prompt = `Match grant application fields to a nonprofit's knowledge base, and draft an answer for each field from the matched entry. Only use information present in the knowledge base — do not invent facts. If no entry fits a field, return kb_id null and answer "".

FIELDS:
${form.fields.map((f) => `- [${f.id}] ${f.question}`).join('\n')}

KNOWLEDGE BASE:
${kb.map((e) => `- [${e._id!.toString()}] Q: ${e.question}\n  A: ${e.answer}`).join('\n')}

Return ONLY a JSON array (no prose, no fences) with one object per field:
[{ "field_id": string, "kb_id": string | null, "answer": string }]
The answer should adapt the knowledge base content to the field's question; keep it concise and factual.`

  let matches: z.infer<typeof Matches>
  try {
    const client = getAnthropic()
    const response = await client.messages.create({
      model: GRANT_OS_MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: prompt }],
    })
    matches = Matches.parse(parseJsonFromText(textFromMessage(response)))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'KB matching failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Apply matches to fields (only where Claude produced a usable answer).
  const validKbIds = new Set(kb.map((e) => e._id!.toString()))
  const byField = new Map(matches.map((m) => [m.field_id, m]))
  const usedKb = new Set<string>()

  form.fields = form.fields.map((f) => {
    const m = byField.get(f.id)
    if (!m || !m.answer.trim()) return f
    const kbValid = m.kb_id && validKbIds.has(m.kb_id)
    if (kbValid) usedKb.add(m.kb_id!)
    return {
      ...f,
      answer: m.answer,
      source: 'kb' as const,
      kb_match_id: kbValid ? new ObjectId(m.kb_id!) : null,
    }
  })

  await formsCol.updateOne(
    { grant_id: grantId, org_id: orgId },
    { $set: { fields: form.fields, completed_pct: completedPct(form.fields), last_updated: new Date() } }
  )

  // Usage stats on the entries we drew from.
  if (usedKb.size > 0) {
    await kbCol.updateMany(
      { _id: { $in: [...usedKb].map((id) => new ObjectId(id)) } },
      { $inc: { times_used: 1 }, $set: { last_used: new Date() } }
    )
  }

  const updated = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
  return NextResponse.json({ form: formToClient(updated!), matched: usedKb.size })
}
