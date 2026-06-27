import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { promoteFormToKb } from '@/lib/kb-promote'

/**
 * POST /api/grants/[id]/promote-kb
 * Manual "feed the knowledge base from this form" action. The same upsert logic
 * also runs automatically when a grant is marked submitted (see grants PATCH).
 */
export const runtime = 'nodejs'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const session = await auth()
    if (!session?.user?.org_id) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid id.' }, { status: 400 })
    }

    const result = await promoteFormToKb(
      new ObjectId(session.user.org_id),
      new ObjectId(id)
    )
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not update the knowledge base.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
