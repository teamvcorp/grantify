import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import type Stripe from 'stripe'
import { orgs } from '@/lib/collections'
import { getStripe, planFromPriceId } from '@/lib/stripe'
import type { Plan } from '@/lib/types'

/**
 * POST /api/billing/webhook — Stripe events that update an org's plan.
 * No auth (Stripe calls it); verified by signature instead. The raw body is
 * required for signature verification, so we read req.text() (never req.json()).
 * Excluded from the proxy matcher (all /api is).
 */
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = req.headers.get('stripe-signature')
  if (!secret || !sig) {
    return NextResponse.json({ error: 'Webhook not configured.' }, { status: 400 })
  }

  const raw = await req.text()
  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(raw, sig, secret)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid signature.'
    return NextResponse.json({ error: `Webhook error: ${message}` }, { status: 400 })
  }

  const col = await orgs()

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object as Stripe.Checkout.Session
    const orgId = s.metadata?.org_id
    const plan = (s.metadata?.plan as Plan | undefined) ?? 'pro'
    if (orgId && ObjectId.isValid(orgId)) {
      await col.updateOne(
        { _id: new ObjectId(orgId) },
        {
          $set: {
            plan,
            stripe_customer_id: (s.customer as string) ?? null,
            stripe_subscription_id: (s.subscription as string) ?? null,
          },
        }
      )
    }
  } else if (event.type === 'customer.subscription.updated') {
    // Plan change / renewal / cancel-at-period-end → resync the org's plan.
    const sub = event.data.object as Stripe.Subscription
    const active = sub.status === 'active' || sub.status === 'trialing'
    const plan = planFromPriceId(sub.items.data[0]?.price.id)
    await col.updateOne(
      { stripe_subscription_id: sub.id },
      { $set: { plan: active && plan ? plan : 'free' } }
    )
  } else if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription
    // Subscription ended → downgrade to free.
    await col.updateOne(
      { stripe_subscription_id: sub.id },
      { $set: { plan: 'free', stripe_subscription_id: null } }
    )
  }

  return NextResponse.json({ received: true })
}
