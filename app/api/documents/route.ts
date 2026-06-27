import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { randomUUID } from 'node:crypto'
import { put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { documents } from '@/lib/collections'
import { DOCUMENT_CATEGORIES } from '@/lib/schemas'
import { logActivity } from '@/lib/activity'
import type { DocumentCategory, OrgDocument } from '@/lib/types'

/**
 * /api/documents — list (GET) and upload (POST) the org's documents.
 * Files live in Vercel Blob; metadata lives in the `documents` collection.
 * Build-safe: @vercel/blob only reads BLOB_READ_WRITE_TOKEN at call time.
 */
export const runtime = 'nodejs'

const MAX_BYTES = 25 * 1024 * 1024 // 25 MB

function toClient(d: OrgDocument) {
  return {
    id: d._id!.toString(),
    name: d.name,
    category: d.category,
    blob_url: d.blob_url,
    file_type: d.file_type,
    grant_id: d.grant_id ? d.grant_id.toString() : null,
    uploaded_at: d.uploaded_at.toISOString(),
  }
}

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  const filter: Record<string, unknown> = { org_id: new ObjectId(session.user.org_id) }
  // ?grant_id=<id> → just that grant's documents; otherwise the whole vault.
  const grantId = new URL(req.url).searchParams.get('grant_id')
  if (grantId && ObjectId.isValid(grantId)) {
    filter.grant_id = new ObjectId(grantId)
  }
  const col = await documents()
  const docs = await col.find(filter).sort({ uploaded_at: -1 }).toArray()
  return NextResponse.json({ documents: docs.map(toClient) })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'A file is required.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File exceeds 25 MB.' }, { status: 413 })
  }

  const rawCategory = String(form.get('category') || 'other')
  const category: DocumentCategory = (
    DOCUMENT_CATEGORIES as readonly string[]
  ).includes(rawCategory)
    ? (rawCategory as DocumentCategory)
    : 'other'

  const orgId = new ObjectId(session.user.org_id)

  // Optional grant scoping — attach the upload to a specific grant.
  const rawGrant = form.get('grant_id')
  const grantId =
    typeof rawGrant === 'string' && ObjectId.isValid(rawGrant)
      ? new ObjectId(rawGrant)
      : null

  // Namespacing the blob path by org keeps tenants' files separate.
  // PRIVATE access: blobs aren't publicly reachable — they're streamed back via
  // the authenticated GET /api/documents/[id] route.
  let blobUrl: string
  let blobPath: string
  try {
    const blob = await put(`${orgId.toString()}/${randomUUID()}-${file.name}`, file, {
      access: 'private',
      contentType: file.type || 'application/octet-stream',
    })
    blobUrl = blob.url
    blobPath = blob.pathname
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const col = await documents()
  const res = await col.insertOne({
    org_id: orgId,
    grant_id: grantId,
    name: file.name,
    category,
    scope: grantId ? 'grant' : 'org',
    blob_url: blobUrl,
    pathname: blobPath,
    file_type: file.type || 'application/octet-stream',
    version: 1,
    uploaded_by: new ObjectId(session.user.id),
    uploaded_at: new Date(),
  })

  if (grantId) {
    await logActivity({
      grant_id: grantId,
      org_id: orgId,
      user_id: new ObjectId(session.user.id),
      type: 'doc_uploaded',
      detail: `Uploaded "${file.name}".`,
    })
  }

  const created = await col.findOne({ _id: res.insertedId })
  return NextResponse.json({ document: toClient(created!) }, { status: 201 })
}
