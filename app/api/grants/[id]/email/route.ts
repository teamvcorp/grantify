import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { budgets, documents, grantForms, grants, orgs } from '@/lib/collections'
import { emailConfigured, sendEmail } from '@/lib/email'
import { renderGrantHtml } from '@/lib/grant-render'

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
  const docNames = docs.map((d) => d.name)
  const orgsCol = await orgs()
  const org = await orgsCol.findOne({ _id: orgId })
  const logoUrl = org?.logo_url ?? ''

  try {
    await sendEmail({
      to,
      subject: `Grant application — ${grant.name}`,
      html: renderGrantHtml(grant, form, budget, docNames, logoUrl),
      // Replies go to the sender, not the no-reply from-address.
      replyTo: session.user.email ?? undefined,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Email send failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  return NextResponse.json({ ok: true, sent_to: to })
}
