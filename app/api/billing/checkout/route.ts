import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getStripe, billingConfigured, priceIdFor } from '@/lib/stripe'

/**
 * POST /api/billing/checkout — start a Stripe Checkout session for a paid plan.
 * Admin only. Requires STRIPE_SECRET_KEY + the plan's STRIPE_PRICE_* env to be set.
 */
export const runtime = 'nodejs'

const BodySchema = z.object({ plan: z.enum(['pro', 'team']) })

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

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid plan.' }, { status: 400 })
  }
  const price = priceIdFor(parsed.data.plan)
  if (!price) {
    return NextResponse.json(
      { error: `No Stripe price configured for the ${parsed.data.plan} plan.` },
      { status: 400 }
    )
  }

  const origin = new URL(req.url).origin
  try {
    const checkout = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: session.user.email ?? undefined,
      // The webhook reads these to set the org's plan after payment.
      metadata: { org_id: session.user.org_id, plan: parsed.data.plan },
      success_url: `${origin}/settings?billing=success`,
      cancel_url: `${origin}/settings`,
    })
    return NextResponse.json({ url: checkout.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
