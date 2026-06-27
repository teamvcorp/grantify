import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { grantForms } from '@/lib/collections'
import { FormPatch } from '@/lib/schemas'
import { completedPct, formToClient } from '@/lib/forms'

/**
 * /api/grants/[id]/form — read (GET) and save manual edits (PATCH) to the
 * AI-generated GrantForm for a grant. Generation/matching live under /api/ai/*.
 */
export const runtime = 'nodejs'

async function scopeFor(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  return {
    filter: {
      grant_id: new ObjectId(id),
      org_id: new ObjectId(session.user.org_id),
    },
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await scopeFor(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  const col = await grantForms()
  const form = await col.findOne(scope.filter)
  return NextResponse.json({ form: form ? formToClient(form) : null })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await scopeFor(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = FormPatch.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid update.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const col = await grantForms()
  const form = await col.findOne(scope.filter)
  if (!form) {
    return NextResponse.json({ error: 'No form for this grant yet.' }, { status: 404 })
  }

  // Apply edited answers by field id (marking them as team-sourced).
  if (parsed.data.answers) {
    const edits = new Map(parsed.data.answers.map((a) => [a.id, a.answer]))
    form.fields = form.fields.map((f) =>
      edits.has(f.id)
        ? { ...f, answer: edits.get(f.id)!, source: 'team' as const }
        : f
    )
  }
  if (parsed.data.narrative_draft !== undefined) {
    form.narrative_draft = parsed.data.narrative_draft
  }
  if (parsed.data.loi_draft !== undefined) {
    form.loi_draft = parsed.data.loi_draft
  }

  await col.updateOne(scope.filter, {
    $set: {
      fields: form.fields,
      narrative_draft: form.narrative_draft,
      loi_draft: form.loi_draft ?? '',
      completed_pct: completedPct(form.fields),
      last_updated: new Date(),
    },
  })
  return NextResponse.json({ ok: true })
}
