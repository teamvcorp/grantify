import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { orgs } from '@/lib/collections'
import { OrgUpdate } from '@/lib/schemas'
import { billingConfigured } from '@/lib/stripe'

/**
 * /api/org — the current org's profile (GET) and edits (PATCH, admin only).
 * Also returns the caller's role so the UI can gate admin actions.
 */
export const runtime = 'nodejs'

export async function GET() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  const col = await orgs()
  const org = await col.findOne({ _id: new ObjectId(session.user.org_id) })
  if (!org) return NextResponse.json({ error: 'Org not found.' }, { status: 404 })

  return NextResponse.json({
    org: {
      id: org._id!.toString(),
      name: org.name,
      ein: org.ein,
      plan: org.plan,
      ai_instructions: org.ai_instructions ?? '',
    },
    role: session.user.role,
    billing_configured: billingConfigured(),
  })
}

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Admins only.' }, { status: 403 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = OrgUpdate.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid org.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const col = await orgs()
  await col.updateOne(
    { _id: new ObjectId(session.user.org_id) },
    { $set: parsed.data }
  )
  return NextResponse.json({ ok: true })
}
