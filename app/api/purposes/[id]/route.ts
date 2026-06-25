import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { grants, purposes } from '@/lib/collections'
import { PurposeInput } from '@/lib/schemas'

/**
 * /api/purposes/[id] — update (PATCH) and delete (DELETE) one Purpose.
 * Every operation is filtered by both _id AND the session org_id, so one org can
 * never touch another's data even with a guessed id — see NOTES.md.
 */
export const runtime = 'nodejs'

async function orgScope(id: string) {
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
  const scope = await orgScope(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  // Allow partial updates: every field is optional on PATCH.
  const parsed = PurposeInput.partial().safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid purpose.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const col = await purposes()
  const result = await col.updateOne(scope.filter, {
    $set: { ...parsed.data, updated_at: new Date() },
  })
  if (result.matchedCount === 0) {
    return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await orgScope(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }

  // Guard: don't orphan grants. Refuse to delete a purpose that still has grants.
  const grantsCol = await grants()
  const linked = await grantsCol.countDocuments({ purpose_id: scope.filter._id })
  if (linked > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${linked} grant(s) are still linked to this purpose.` },
      { status: 409 }
    )
  }

  const col = await purposes()
  const result = await col.deleteOne(scope.filter)
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
