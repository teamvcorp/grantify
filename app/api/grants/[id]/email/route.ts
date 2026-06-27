import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { get } from '@vercel/blob'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { budgets, documents, grantForms, grants, orgs } from '@/lib/collections'
import { emailConfigured, sendEmail, type EmailAttachment } from '@/lib/email'
import { renderGrantHtml } from '@/lib/grant-render'

/** Resend caps a message (body + attachments) at 40 MB; stay well under it. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * POST /api/grants/[id]/email — email the complete grant (form + narrative +
 * budget) as a formatted HTML email. Recipient defaults to the signed-in user;
 * an optional `to` overrides it. Requires Resend to be configured.
 */
export const runtime = 'nodejs'

const BodySchema = z.object({ to: z.email().optional() })

export async function POST(
  req: Request,
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
  if (!emailConfigured()) {
    return NextResponse.json(
      { error: 'Email is not configured (set RESEND_API_KEY and RESEND_FROM).' },
      { status: 503 }
    )
  }

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // Empty body is fine — we default the recipient below.
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid recipient email.' }, { status: 400 })
  }
  const to = parsed.data.to ?? session.user.email
  if (!to) {
    return NextResponse.json({ error: 'No recipient email.' }, { status: 400 })
  }

  const orgId = new ObjectId(session.user.org_id)
  const grantOid = new ObjectId(id)

  const grantsCol = await grants()
  const grant = await grantsCol.findOne({ _id: grantOid, org_id: orgId })
  if (!grant) {
    return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
  }
  const formsCol = await grantForms()
  const form = await formsCol.findOne({ grant_id: grantOid, org_id: orgId })
  const budgetsCol = await budgets()
  const budget = await budgetsCol.findOne({ grant_id: grantOid, org_id: orgId })
  const docsCol = await documents()
  const docs = await docsCol.find({ grant_id: grantOid, org_id: orgId }).toArray()
  const orgsCol = await orgs()
  const org = await orgsCol.findOne({ _id: orgId })
  const logoUrl = org?.logo_url ?? ''

  // Download each supporting doc from the private blob store and attach it.
  // Skip (rather than fail the whole send) anything that can't be fetched, and
  // stop once we'd exceed Resend's size budget — the body still lists every doc.
  const attachments: EmailAttachment[] = []
  const attached: string[] = []
  const omitted: string[] = []
  let totalBytes = 0
  for (const doc of docs) {
    try {
      const result = await get(doc.pathname, { access: 'private' })
      if (!result || result.statusCode !== 200) {
        omitted.push(doc.name)
        continue
      }
      const buf = Buffer.from(await new Response(result.stream).arrayBuffer())
      if (totalBytes + buf.length > MAX_ATTACHMENT_BYTES) {
        omitted.push(doc.name)
        continue
      }
      totalBytes += buf.length
      attachments.push({
        filename: doc.name,
        content: buf,
        contentType: doc.file_type || result.blob.contentType || 'application/octet-stream',
      })
      attached.push(doc.name)
    } catch {
      omitted.push(doc.name)
    }
  }

  try {
    await sendEmail({
      to,
      subject: `Grant application — ${grant.name}`,
      html: renderGrantHtml(grant, form, budget, { attached, omitted }, logoUrl),
      attachments: attachments.length ? attachments : undefined,
      // Replies go to the sender, not the no-reply from-address.
      replyTo: session.user.email ?? undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Email send failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  return NextResponse.json({ ok: true, sent_to: to })
}
