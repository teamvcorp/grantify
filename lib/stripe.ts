import Stripe from 'stripe'
import type { Plan } from './types'

/**
 * Stripe client — BUILD-SAFE (lazy, like the Mongo/Anthropic clients). The key
 * is read inside getStripe() so a missing STRIPE_SECRET_KEY can't throw during
 * `next build`. Billing is a scaffold: it works once you add the keys + price
 * IDs below to the environment; until then `billingConfigured()` is false and
 * the routes return a clear "not configured" error. Server-only.
 */

let client: Stripe | undefined

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set. Billing is not configured.')
  }
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY)
  return client
}

/** True when the minimum env to run a checkout exists. */
export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

/** Map a paid plan to its configured Stripe Price id. */
export function priceIdFor(plan: Plan): string | undefined {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO
  if (plan === 'team') return process.env.STRIPE_PRICE_TEAM
  return undefined
}
