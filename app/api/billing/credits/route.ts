import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getStripe, billingConfigured, tokenReupPriceId } from '@/lib/stripe'

/**
 * POST /api/billing/credits — buy AI usage credits (one-time payment).
 * Each unit is one TOKEN_REUP_PLAN purchase ($5). Admin only; requires Stripe
 * configured + TOKEN_REUP_PLAN set. The webhook adds the credits on completion.
 */
export const runtime = 'nodejs'

const BodySchema = z.object({ units: z.number().int().min(1).max(50).optional() })

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
  const price = tokenReupPriceId()
  if (!price) {
    return NextResponse.json({ error: 'Credit top-up is not configured.' }, { status: 400 })
  }

  let body: unknown = {}
  try {
    body = await req.json()
  } catch {
    // default units below
  }
  const parsed = BodySchema.safeParse(body)
  const units = parsed.success && parsed.data.units ? parsed.data.units : 1

  const origin = new URL(req.url).origin
  try {
    const checkout = await getStripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price, quantity: units }],
      customer_email: session.user.email ?? undefined,
      // The webhook reads these to add credits after payment.
      metadata: { org_id: session.user.org_id, type: 'credits', units: String(units) },
      success_url: `${origin}/dashboard?credits=success`,
      cancel_url: `${origin}/dashboard`,
    })
    return NextResponse.json({ url: checkout.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Checkout failed.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
