import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { purposes } from '@/lib/collections'
import { PurposeInput } from '@/lib/schemas'
import type { Purpose } from '@/lib/types'

/**
 * /api/purposes — list (GET) and create (POST) the current org's Purposes.
 * Multi-tenancy: every query is filtered/stamped with the session org_id — see NOTES.md.
 */
export const runtime = 'nodejs'

/** Map a DB document to the client shape (ObjectId → string). */
function toClient(p: Purpose) {
  return {
    id: p._id!.toString(),
    name: p.name,
    description: p.description,
    focus_areas: p.focus_areas,
    geography: p.geography,
    target_amount: p.target_amount,
    grant_types: p.grant_types,
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const col = await purposes()
  const docs = await col
    .find({ org_id: new ObjectId(session.user.org_id) })
    .sort({ created_at: -1 })
    .toArray()

  return NextResponse.json({ purposes: docs.map(toClient) })
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
  const parsed = PurposeInput.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid purpose.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const now = new Date()
  const col = await purposes()
  const res = await col.insertOne({
    org_id: new ObjectId(session.user.org_id),
    ...parsed.data,
    created_at: now,
    updated_at: now,
  })
  const created = await col.findOne({ _id: res.insertedId })
  return NextResponse.json({ purpose: toClient(created!) }, { status: 201 })
}
