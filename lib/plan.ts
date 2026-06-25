import type { Plan } from './types'

/**
 * Plan tiers and their limits. The member cap is the example gate enforced in
 * /api/team; add more limits here (purposes, AI runs, etc.) as needed.
 */
export const PLANS: Record<Plan, { label: string; price: string; members: number }> = {
  free: { label: 'Free', price: '$0', members: 2 },
  pro: { label: 'Pro', price: '$49/mo', members: 10 },
  team: { label: 'Team', price: '$149/mo', members: Number.POSITIVE_INFINITY },
}

export function memberLimit(plan: Plan): number {
  return PLANS[plan]?.members ?? PLANS.free.members
}
