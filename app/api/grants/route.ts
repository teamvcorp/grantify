import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { grants, purposes } from '@/lib/collections'
import { GrantInput, GRANT_STATUSES } from '@/lib/schemas'
import type { Grant, GrantPhase } from '@/lib/types'

/**
 * /api/grants — list (GET) and import/create (POST) the org's grants.
 * Both federal (Grants.gov) and AI-discovered grants flow through POST here;
 * the only difference is `discovered_by` and which fields the client fills.
 * Multi-tenancy: org_id from the session on every query — see NOTES.md.
 */
export const runtime = 'nodejs'

function toClient(g: Grant) {
  return {
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
    focus_areas: g.focus_areas,
    notes: g.notes,
    discovered_by: g.discovered_by,
    grantsgov_id: g.grantsgov_id ?? null,
  }
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const url = new URL(req.url)
  const filter: Record<string, unknown> = { org_id: new ObjectId(session.user.org_id) }

  const purposeId = url.searchParams.get('purpose_id')
  if (purposeId && ObjectId.isValid(purposeId)) {
    filter.purpose_id = new ObjectId(purposeId)
  }
  const status = url.searchParams.get('status')
  if (status && (GRANT_STATUSES as readonly string[]).includes(status)) {
    filter.status = status
  }

  const col = await grants()
  const docs = await col.find(filter).sort({ updated_at: -1 }).toArray()
  return NextResponse.json({ grants: docs.map(toClient) })
}

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
  const parsed = GrantInput.safeParse(body)
  if (!parsed.success || !ObjectId.isValid(parsed.data.purpose_id)) {
    return NextResponse.json(
      { error: 'Invalid grant.', details: parsed.success ? undefined : parsed.error.flatten() },
      { status: 400 }
    )
  }

  const orgId = new ObjectId(session.user.org_id)
  const purposeId = new ObjectId(parsed.data.purpose_id)

  // The target purpose must belong to this org.
  const purposesCol = await purposes()
  const purpose = await purposesCol.findOne({ _id: purposeId, org_id: orgId })
  if (!purpose) {
    return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
  }

  // Skip duplicate federal imports (same org + Grants.gov id).
  const col = await grants()
  if (parsed.data.grantsgov_id) {
    const existing = await col.findOne({
      org_id: orgId,
      grantsgov_id: parsed.data.grantsgov_id,
    })
    if (existing) {
      return NextResponse.json(
        { grant: toClient(existing), duplicate: true },
        { status: 200 }
      )
    }
  }

  const now = new Date()
  const { deadline_full, purpose_id: _pid, phase, ...rest } = parsed.data
  void _pid
  const res = await col.insertOne({
    ...rest,
    phase: phase as GrantPhase,
    org_id: orgId,
    purpose_id: purposeId,
    deadline_loi: null,
    deadline_full: deadline_full ? new Date(deadline_full) : null,
    deadline_report: null,
    created_at: now,
    updated_at: now,
  })
  const created = await col.findOne({ _id: res.insertedId })
  return NextResponse.json({ grant: toClient(created!) }, { status: 201 })
}
