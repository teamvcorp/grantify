import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { orgs } from '@/lib/collections'
import { getStripe, billingConfigured } from '@/lib/stripe'

/**
 * POST /api/billing/portal — open the Stripe Customer Portal (manage/cancel).
 * Admin only; requires the org to already have a Stripe customer.
 */
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  if (session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Admins only.' }, { status: 403 })
  }
  if (!billingConfigured()) {
    return NextResponse.json({ error: 'Billing is not configured.' }, { status: 503 })
  }

  const col = await orgs()
  const org = await col.findOne({ _id: new ObjectId(session.user.org_id) })
  if (!org?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account yet.' }, { status: 400 })
  }

  const origin = new URL(req.url).origin
  try {
    const portal = await getStripe().billingPortal.sessions.create({
      customer: org.stripe_customer_id,
      return_url: `${origin}/settings`,
    })
    return NextResponse.json({ url: portal.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not open billing portal.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
