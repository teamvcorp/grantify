import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { activities } from '@/lib/collections'

/** GET /api/grants/[id]/activity — the grant's activity log (newest first). */
export const runtime = 'nodejs'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })
  }

  const col = await activities()
  const docs = await col
    .find({ grant_id: new ObjectId(id), org_id: new ObjectId(session.user.org_id) })
    .sort({ created_at: -1 })
    .limit(100)
    .toArray()

  return NextResponse.json({
    activity: docs.map((a) => ({
      id: a._id!.toString(),
      type: a.type,
      detail: a.detail,
      created_at: a.created_at.toISOString(),
    })),
  })
}
