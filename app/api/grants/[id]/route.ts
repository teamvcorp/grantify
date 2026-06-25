import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { grants } from '@/lib/collections'
import { GrantPatch } from '@/lib/schemas'
import { logActivity } from '@/lib/activity'
import type { Grant, GrantPhase } from '@/lib/types'

/**
 * /api/grants/[id] — update (PATCH) and delete (DELETE) one grant, org-scoped.
 */
export const runtime = 'nodejs'

async function orgFilter(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  const orgId = new ObjectId(session.user.org_id)
  const grantOid = new ObjectId(id)
  return {
    orgId,
    grantOid,
    userId: new ObjectId(session.user.id),
    filter: { _id: grantOid, org_id: orgId },
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await orgFilter(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  const col = await grants()
  const g = await col.findOne(scope.filter)
  if (!g) return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  return NextResponse.json({
    grant: {
      id: g._id!.toString(),
      purpose_id: g.purpose_id.toString(),
      name: g.name,
      funder: g.funder,
      funder_type: g.funder_type,
      amount_min: g.amount_min,
      amount_max: g.amount_max,
      status: g.status,
      phase: g.phase,
      deadline_full: g.deadline_full ? g.deadline_full.toISOString() : null,
      url: g.url,
      requirements_raw: g.requirements_raw,
      notes: g.notes,
    },
  })
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
  const parsed = GrantPatch.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid update.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { phase, ...others } = parsed.data
  const update: Partial<Grant> = { ...others, updated_at: new Date() }
  if (phase !== undefined) update.phase = phase as GrantPhase

  const col = await grants()
  const result = await col.updateOne(scope.filter, { $set: update })
  if (result.matchedCount === 0) {
    return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  }

  if (parsed.data.status) {
    await logActivity({
      grant_id: scope.grantOid,
      org_id: scope.orgId,
      user_id: scope.userId,
      type: 'status_change',
      detail: `Status changed to ${parsed.data.status}.`,
    })
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

  const col = await grants()
  const result = await col.deleteOne(scope.filter)
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
