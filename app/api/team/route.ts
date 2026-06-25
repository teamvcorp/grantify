import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { orgs, users } from '@/lib/collections'
import { MemberInput } from '@/lib/schemas'
import { hashPassword } from '@/lib/password'
import { memberLimit } from '@/lib/plan'
import { emailConfigured, sendEmail } from '@/lib/email'
import type { User } from '@/lib/types'

/**
 * /api/team — list (GET) and add (POST, admin only) members of the org.
 */
export const runtime = 'nodejs'

function toClient(u: User) {
  return {
    id: u._id!.toString(),
    email: u.email,
    name: u.name,
    role: u.role,
    last_login: u.last_login ? u.last_login.toISOString() : null,
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  const col = await users()
  const docs = await col
    .find({ org_id: new ObjectId(session.user.org_id) })
    .sort({ created_at: 1 })
    .toArray()
  return NextResponse.json({
    members: docs.map(toClient),
    me: session.user.id,
    role: session.user.role,
  })
}

export async function POST(req: Request) {
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
  const parsed = MemberInput.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid member.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const orgId = new ObjectId(session.user.org_id)
  const col = await users()

  // Plan gate: enforce the member cap for the org's current plan.
  const orgsCol = await orgs()
  const org = await orgsCol.findOne({ _id: orgId })
  const limit = memberLimit(org?.plan ?? 'free')
  const current = await col.countDocuments({ org_id: orgId })
  if (current >= limit) {
    return NextResponse.json(
      { error: `Your ${org?.plan ?? 'free'} plan allows ${limit} members. Upgrade to add more.` },
      { status: 403 }
    )
  }

  const email = parsed.data.email.toLowerCase()
  try {
    const res = await col.insertOne({
      org_id: new ObjectId(session.user.org_id),
      email,
      name: parsed.data.name,
      role: parsed.data.role,
      password_hash: await hashPassword(parsed.data.password),
      avatar_url: null,
      created_at: new Date(),
      last_login: null,
    })
    // Best-effort welcome email — a login link, never the password (the admin
    // shares the temp password out of band).
    if (emailConfigured()) {
      const origin = new URL(req.url).origin
      await sendEmail({
        to: email,
        subject: 'You’ve been added to Grant OS',
        html: `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111">
          <p>Hi ${parsed.data.name},</p>
          <p>An account was created for you on Grant OS. Sign in here:</p>
          <p><a href="${origin}/login">${origin}/login</a></p>
          <p>Your administrator will share your temporary password separately. Use the email <strong>${email}</strong> to sign in.</p>
        </div>`,
      }).catch(() => {})
    }

    const created = await col.findOne({ _id: res.insertedId })
    return NextResponse.json({ member: toClient(created!) }, { status: 201 })
  } catch (err) {
    // Unique index on email → duplicate key.
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      return NextResponse.json({ error: 'A user with that email already exists.' }, { status: 409 })
    }
    throw err
  }
}
