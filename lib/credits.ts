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
  /**
   * Cache-READ price as a multiple of the base input price. Standard is 0.1x,
   * but it is NOT uniform — assuming 0.1x overcharges on the models that
   * discount it further. Verified against the pricing docs on 2026-09-29.
   */
  cacheReadMult?: number
}

/**
 * Per-token prices, USD per token. Source: platform.claude.com pricing page,
 * checked 2026-09-29. EVERY model used by lib/anthropic.ts must appear here or
 * it bills at the fail-safe rate below.
 */
const PRICES: Record<string, ModelPrice> = {
  // Current per-task pins.
  'claude-sonnet-5-5': { input: 2 / M, output: 10 / M },
  'claude-opus-5-5': { input: 4 / M, output: 20 / M, cacheReadMult: 0.05 },
  // Previously pinned / still selectable via ANTHROPIC_MODEL.
  'claude-sonnet-5': { input: 2 / M, output: 10 / M },
  'claude-sonnet-4-6': { input: 3 / M, output: 15 / M },
  'claude-opus-5': { input: 5 / M, output: 25 / M },
  'claude-opus-4-8': { input: 5 / M, output: 25 / M },
  'claude-haiku-4-5': { input: 1 / M, output: 5 / M },
  'claude-fable-5-1': { input: 10 / M, output: 50 / M, cacheReadMult: 0.025 },
}

/** Standard cache-read multiplier when a model doesn't override it. */
const DEFAULT_CACHE_READ_MULT = 0.1

/**
 * Fail-safe for a model with no price entry (someone sets ANTHROPIC_MODEL to
 * something unlisted). We deliberately fall back to the MOST EXPENSIVE known
 * rate, not the pinned model's: undercharging silently eats real margin on
 * every call, while overcharging is visible and refundable. Keep PRICES current
 * — this is a backstop, not a pricing strategy. Unknown models are logged once
 * per call so the gap surfaces in the function logs.
 */
const DEFAULT_PRICE: ModelPrice = Object.values(PRICES).reduce((a, b) =>
  b.output > a.output ? b : a
)

/**
 * Server-side web search: $10 per 1,000 searches. CONFIRMED against the
 * pricing docs 2026-09-29 — this was previously an estimate and it was exactly
 * right. Web FETCH is free beyond the tokens of the page it pulls in, so there
 * is deliberately no per-fetch charge here.
 */
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
  const p = PRICES[model]
  if (!p) {
    console.warn(
      `[credits] No price entry for model "${model}" — billing at the highest known rate. Add it to PRICES in lib/credits.ts.`
    )
  }
  const price = p ?? DEFAULT_PRICE
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const searches = usage.server_tool_use?.web_search_requests ?? 0
  const cacheReadMult = price.cacheReadMult ?? DEFAULT_CACHE_READ_MULT
  return (
    input * price.input +
    output * price.output +
    cacheRead * price.input * cacheReadMult + // 0.1x, but 0.05x on Opus 5.5
    cacheWrite * price.input * 1.25 + // 5-minute cache writes 1.25× input
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
