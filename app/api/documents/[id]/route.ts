import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { del } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { documents } from '@/lib/collections'

/** /api/documents/[id] — delete a document (blob + metadata), org-scoped. */
export const runtime = 'nodejs'

export async function DELETE(
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

  const filter = { _id: new ObjectId(id), org_id: new ObjectId(session.user.org_id) }
  const col = await documents()
  const doc = await col.findOne(filter)
  if (!doc) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  // Remove the blob first; if that fails we keep the metadata so it isn't orphaned.
  try {
    await del(doc.blob_url)
  } catch {
    // Blob may already be gone; proceed to remove metadata regardless.
  }
  await col.deleteOne(filter)
  return NextResponse.json({ ok: true })
}
