import Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic client + shared config.
 *
 * BUILD-SAFE: the client is created lazily so a missing ANTHROPIC_API_KEY can't
 * throw during `next build`. All AI calls are server-side only — this module
 * must never be imported into a client component (the key would leak into the
 * browser bundle).
 *
 * MODEL CHOICE: claude-sonnet-5 (was claude-sonnet-4-6). Sonnet 5 reaches
 * roughly the previous Opus tier on agentic work at a LOWER per-token price
 * ($2/$10 per 1M vs $3/$15) — but it uses the newer tokenizer, which produces
 * ~30% more tokens for the same text, so real spend is roughly a wash rather
 * than a 33% saving. Every route's `max_tokens` was raised ~30% to match.
 *
 * It's a single constant so you can switch to claude-opus-5 (more capable,
 * $5/$25) via ANTHROPIC_MODEL. IMPORTANT: any model you switch to must have a
 * price entry in lib/credits.ts — an unpriced model falls back to the most
 * expensive known rate, which overcharges rather than silently eating margin.
 *
 * Opus 5 caveat: five routes run `thinking: {type:'disabled'}`. On Opus 5 that
 * combination can make the model write a tool call as PLAIN TEXT instead of a
 * real tool_use block — the turn "succeeds" and the search never runs. Move
 * those routes to `{type:'adaptive'}` + a low/medium `output_config.effort`
 * before pinning Opus 5.
 */

export const GRANT_OS_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

/**
 * WEB SEARCH — deliberately the BASIC variant, not the newer dynamic-filtering
 * one. MEASURED on claude-sonnet-5, 2026-09-07, identical prompt and max_uses:
 *
 *   web_search_20250305 (basic)    →   7.6s
 *   web_search_20260209 (dynamic)  → 315.3s      (~40x slower)
 *
 * `max_uses` made no difference to the dynamic variant (2 uses: 331s), so the
 * cost is the variant itself: dynamic filtering runs code execution in a
 * container under the hood, and we pay for that container on every call.
 *
 * That single line was the root cause of AI discovery timing out and returning
 * nothing — it blew past Vercel's 300s cap before any result could be produced.
 * We do our own verification and qualification gate anyway (see lib/discovery.ts),
 * so the dynamic variant's extra filtering buys us little for 40x the latency.
 *
 * If you ever switch back, keep the `container` handling in the pause_turn
 * resume loops — the dynamic variants require it. See docs/anthropic-web-tools.md.
 */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305' as const,
  name: 'web_search' as const,
}

/**
 * WEB FETCH — basic variant, for the same reason as WEB_SEARCH_TOOL above.
 * Lets the model open a specific URL and read the page, so it can VERIFY a
 * discovered grant against its real source instead of trusting search snippets.
 *
 * MEASURED on claude-sonnet-5, 2026-09-07, same page and prompt:
 *   web_fetch_20250910 (basic)    →  5.7s
 *   web_fetch_20260209 (dynamic)  → 20.8s        (~3.6x slower)
 * Both read the page correctly and both reached the same conclusion about it.
 *
 * See docs/anthropic-web-tools.md.
 */
export const WEB_FETCH_TOOL = {
  type: 'web_fetch_20250910' as const,
  name: 'web_fetch' as const,
}

let client: Anthropic | undefined

export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env.local (local) or the Vercel project env (deploy).'
    )
  }
  if (!client) {
    client = new Anthropic() // reads ANTHROPIC_API_KEY from env
  }
  return client
}

/**
 * Extract the concatenated text from a non-streaming message response.
 * Guards against refusal stop reasons and non-text blocks.
 */
export function textFromMessage(message: Anthropic.Message): string {
  if (message.stop_reason === 'refusal') {
    throw new Error('The AI declined this request for safety reasons.')
  }
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * Models sometimes wrap JSON in ```json fences or add prose despite
 * instructions. Strip fences and parse. Throws if no valid JSON is found.
 */
export function parseJsonFromText<T>(text: string): T {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1].trim() : trimmed
  try {
    return JSON.parse(candidate) as T
  } catch {
    // Last resort: grab the outermost array or object.
    const match = candidate.match(/[[{][\s\S]*[\]}]/)
    if (match) return JSON.parse(match[0]) as T
    throw new Error('Could not parse JSON from the AI response.')
  }
}
