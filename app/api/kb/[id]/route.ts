import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { knowledgeBase } from '@/lib/collections'
import { KbInput } from '@/lib/schemas'

/** /api/kb/[id] — update (PATCH) and delete (DELETE) one KB entry, org-scoped. */
export const runtime = 'nodejs'

async function orgFilter(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  return {
    filter: { _id: new ObjectId(id), org_id: new ObjectId(session.user.org_id) },
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await orgFilter(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = KbInput.partial().safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid entry.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const set: Record<string, unknown> = { ...parsed.data, updated_at: new Date() }
  // Keep embedding_text in sync when the text changes.
  if (parsed.data.question !== undefined || parsed.data.answer !== undefined) {
    const col = await knowledgeBase()
    const current = await col.findOne(scope.filter)
    if (!current) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    const q = parsed.data.question ?? current.question
    const a = parsed.data.answer ?? current.answer
    set.embedding_text = `${q}\n${a}`
  }

  const col = await knowledgeBase()
  const result = await col.updateOne(scope.filter, { $set: set })
  if (result.matchedCount === 0) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await orgFilter(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  const col = await knowledgeBase()
  const result = await col.deleteOne(scope.filter)
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
