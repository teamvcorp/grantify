import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { budgets, grants } from '@/lib/collections'
import { BudgetInput } from '@/lib/schemas'
import type { Budget } from '@/lib/types'

/**
 * /api/grants/[id]/budget — read (GET) and replace (PUT) a grant's budget.
 * One budget document per grant; PUT is a full replace of items + notes.
 */
export const runtime = 'nodejs'

async function scopeFor(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  return {
    orgId: new ObjectId(session.user.org_id),
    grantId: new ObjectId(id),
  }
}

function toClient(b: Budget | null) {
  if (!b) return { items: [], notes: '' }
  return { items: b.items, notes: b.notes }
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
  const col = await budgets()
  const budget = await col.findOne({ grant_id: scope.grantId, org_id: scope.orgId })
  return NextResponse.json({ budget: toClient(budget) })
}

export async function PUT(
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
  const parsed = BudgetInput.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid budget.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // The grant must belong to this org.
  const grantsCol = await grants()
  const grant = await grantsCol.findOne({ _id: scope.grantId, org_id: scope.orgId })
  if (!grant) {
    return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  }

  const now = new Date()
  const col = await budgets()
  await col.updateOne(
    { grant_id: scope.grantId, org_id: scope.orgId },
    {
      $set: { items: parsed.data.items, notes: parsed.data.notes, updated_at: now },
      $setOnInsert: { created_at: now },
    },
    { upsert: true }
  )
  return NextResponse.json({ ok: true })
}
