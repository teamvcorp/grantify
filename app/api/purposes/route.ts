import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { purposes } from '@/lib/collections'

/**
 * GET /api/purposes
 * List the current org's Purposes (id + the fields the discovery UI needs).
 *
 * Multi-tenancy: filtered by the session org_id — see NOTES.md.
 */
export const runtime = 'nodejs'

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

  return NextResponse.json({
    purposes: docs.map((p) => ({
      id: p._id!.toString(),
      name: p.name,
      geography: p.geography,
      focus_areas: p.focus_areas,
      target_amount: p.target_amount,
    })),
  })
}
