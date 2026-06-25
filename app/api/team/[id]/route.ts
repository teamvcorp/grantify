import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { users } from '@/lib/collections'
import { MemberPatch } from '@/lib/schemas'
import { hashPassword } from '@/lib/password'

/**
 * /api/team/[id] — change role (PATCH) and remove (DELETE) a member.
 * Admin only. You cannot remove yourself or demote your own admin role
 * (prevents an org locking itself out of admin access).
 */
export const runtime = 'nodejs'

async function adminScope(id: string) {
  const session = await auth()
  if (!session?.user?.org_id) return { error: 'Not authenticated.', status: 401 as const }
  if (session.user.role !== 'admin') return { error: 'Admins only.', status: 403 as const }
  if (!ObjectId.isValid(id)) return { error: 'Invalid id.', status: 400 as const }
  return {
    me: session.user.id,
    filter: { _id: new ObjectId(id), org_id: new ObjectId(session.user.org_id) },
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await adminScope(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = MemberPatch.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid update.' }, { status: 400 })
  }
  // You can reset your own password, but not change your own role.
  if (parsed.data.role !== undefined && id === scope.me) {
    return NextResponse.json({ error: 'You cannot change your own role.' }, { status: 400 })
  }

  const set: Record<string, unknown> = {}
  if (parsed.data.role !== undefined) set.role = parsed.data.role
  if (parsed.data.password !== undefined) set.password_hash = await hashPassword(parsed.data.password)

  const col = await users()
  const result = await col.updateOne(scope.filter, { $set: set })
  if (result.matchedCount === 0) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const scope = await adminScope(id)
  if ('error' in scope) {
    return NextResponse.json({ error: scope.error }, { status: scope.status })
  }
  if (id === scope.me) {
    return NextResponse.json({ error: 'You cannot remove yourself.' }, { status: 400 })
  }
  const col = await users()
  const result = await col.deleteOne(scope.filter)
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
