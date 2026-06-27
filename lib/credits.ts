import type { ObjectId } from 'mongodb'
import { orgs } from './collections'

/**
 * AI usage credits. We bill orgs 2× the raw Anthropic API cost of each call —
 * enough margin to stay alive, no more. Balances are stored on the org in
 * cents (`ai_credits_cents`); each AI route checks the balance before calling
 * Claude and deducts the billed cost after.
 *
 * Pricing is per-token (USD). Source: Claude API pricing reference.
 */

const M = 1_000_000

interface ModelPrice {
  input: number // USD per input token
  output: number // USD per output token
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-6': { input: 3 / M, output: 15 / M },
  'claude-opus-4-8': { input: 5 / M, output: 25 / M },
  'claude-haiku-4-5': { input: 1 / M, output: 5 / M },
}
const DEFAULT_PRICE = PRICES['claude-sonnet-4-6']

// Server-side web search: ~$10 per 1,000 requests (estimate; tune as needed).
const WEB_SEARCH_PER_REQUEST = 0.01
// We charge double the raw Anthropic cost.
const MARGIN = 2

/** Free credits a new org starts with (also backfilled on first AI use). */
export const STARTER_CREDITS_CENTS = 500 // $5
/** Credit granted per TOKEN_REUP_PLAN unit purchased ($5 each). */
export const CREDIT_PER_REUP_CENTS = 500

interface UsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

/** Raw Anthropic cost of one response, in USD. */
function rawCostUsd(model: string, usage: UsageLike): number {
  const p = PRICES[model] ?? DEFAULT_PRICE
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  return (
    input * p.input +
    output * p.output +
    cacheRead * p.input * 0.1 + // cache reads ~0.1× input
    cacheWrite * p.input * 1.25 + // 5-minute cache writes ~1.25× input
    searches * WEB_SEARCH_PER_REQUEST
  )
}

/** Billed cost in cents (2× raw, rounded up so we never undercharge). */
export function billedCents(model: string, usage: UsageLike): number {
  return Math.ceil(rawCostUsd(model, usage) * MARGIN * 100)
}

/**
 * Current balance in cents. Backfills the starter allowance once for orgs that
 * predate the credits system (so existing orgs aren't instantly locked out).
 */
export async function getCreditCents(orgId: ObjectId): Promise<number> {
  const col = await orgs()
  const org = await col.findOne({ _id: orgId })
  if (!org) return 0
  if (org.ai_credits_cents == null) {
    await col.updateOne(
      { _id: orgId, ai_credits_cents: { $exists: false } },
      { $set: { ai_credits_cents: STARTER_CREDITS_CENTS } }
    )
    return STARTER_CREDITS_CENTS
  }
  return org.ai_credits_cents
}

/** Gate before an AI call. Returns false when the org is out of credits. */
export async function hasCredits(orgId: ObjectId): Promise<boolean> {
  return (await getCreditCents(orgId)) > 0
}

/** Deduct the billed cost of a response from the org's balance (best-effort). */
export async function chargeUsage(
  orgId: ObjectId,
  model: string,
  usage: UsageLike | null | undefined
): Promise<void> {
  if (!usage) return
  const cents = billedCents(model, usage)
  if (cents <= 0) return
  const col = await orgs()
  await col
    .updateOne({ _id: orgId }, { $inc: { ai_credits_cents: -cents, ai_spent_cents: cents } })
    .catch(() => {})
}

/** Add purchased credits to the balance. */
export async function addCredits(orgId: ObjectId, cents: number): Promise<void> {
  const col = await orgs()
  await col.updateOne({ _id: orgId }, { $inc: { ai_credits_cents: cents } })
}
