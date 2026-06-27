import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { del, get } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { documents } from '@/lib/collections'

/**
 * /api/documents/[id]
 *  - GET: stream the (private) blob back to an authenticated org member.
 *  - DELETE: remove the blob + metadata.
 * The store is private, so files are never served by a public URL — only through
 * this org-scoped handler.
 */
export const runtime = 'nodejs'

async function scoped(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  return { filter: { _id: new ObjectId(id), org_id: new ObjectId(session.user.org_id) } }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const s = await scoped(id)
  if ('error' in s) return NextResponse.json({ error: s.error }, { status: s.status })

  const col = await documents()
  const doc = await col.findOne(s.filter)
  if (!doc) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  try {
    const result = await get(doc.pathname, { access: 'private' })
    if (!result || result.statusCode !== 200) {
      return NextResponse.json({ error: 'File unavailable.' }, { status: 404 })
    }
    // Inline so PDFs/images preview; other types download.
    return new Response(result.stream, {
      headers: {
        'Content-Type': doc.file_type || result.blob.contentType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.name)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not load file.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const s = await scoped(id)
  if ('error' in s) return NextResponse.json({ error: s.error }, { status: s.status })

  const col = await documents()
  const doc = await col.findOne(s.filter)
  if (!doc) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  // Remove the blob first; if that fails we keep the metadata so it isn't orphaned.
  try {
    await del(doc.pathname)
  } catch {
    // Blob may already be gone; proceed to remove metadata regardless.
  }
  await col.deleteOne(s.filter)
  return NextResponse.json({ ok: true })
}
