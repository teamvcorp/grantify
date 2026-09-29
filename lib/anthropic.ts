import Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic client + shared config.
 *
 * BUILD-SAFE: the client is created lazily so a missing ANTHROPIC_API_KEY can't
 * throw during `next build`. All AI calls are server-side only — this module
 * must never be imported into a client component (the key would leak into the
 * browser bundle).
 *
 * MODEL CHOICE IS PER TASK — see AI_TASK_MODELS below. Routes must call
 * `requestBaseFor(task)` and spread the result; they must NEVER hardcode a
 * `thinking` block, because the legal thinking shape DEPENDS ON THE MODEL:
 *
 *   MEASURED 2026-09-29 against the live API:
 *     claude-sonnet-5-5  thinking:'disabled' → 400   adaptive → OK
 *     claude-opus-5-5    thinking:'disabled' → 400   adaptive → OK
 *     claude-haiku-4-5   thinking:'disabled' → OK    adaptive → 400
 *     claude-sonnet-5    both accepted
 *
 * So a model swap alone is a breaking change. `requestBaseFor` derives the
 * thinking block from the model family, which is the whole point of it.
 */

/** Legacy single-model export. Prefer `modelFor(task)`. Kept for compatibility. */
export const GRANT_OS_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'

/** Every AI operation in the app, so each can pick its own model. */
export type AiTask =
  | 'discover' // phase 1: web search shortlist
  | 'verify' // phase 2: open a page and confirm one grant
  | 'generate-form' // requirements text → form fields
  | 'match-kb' // map KB answers onto form fields
  | 'funding-summary' // summarize what a funder funds
  | 'narrative' // the long grant narrative (core deliverable)
  | 'loi' // letter of intent
  | 'polish' // rewrite one field
  | 'purpose-assist' // natural language → a well-formed, searchable Purpose

/**
 * TASK → MODEL. Chosen from measurements on this app's real prompts
 * (2026-09-29), not from vibes. Numbers in the comments are single runs, so
 * treat them as direction, not precision.
 *
 * Reasoning-heavy PROSE the customer is judged on → Opus 5.5. It is both
 * better AND cheaper than Opus 5 ($4/$20 vs $5/$25), so Opus 5 is strictly
 * dominated and never worth pinning.
 *
 * Structured / high-volume work → Sonnet 5.5 ($2/$10). On the discovery search
 * it beat the old Sonnet 5 + thinking-off baseline on BOTH axes: 6.7s vs 13.5s
 * and 6 usable candidates vs 4. On verification it was measurably more honest:
 * for a program whose deadline had passed, Sonnet 5 returned verified:true
 * while its own prose said "not currently accepting applications"; Sonnet 5.5
 * returned verified:false with the passed date. False positives are expensive
 * here — they reach the user as real grants.
 *
 * Haiku 4.5 is NOT used: it is the fastest, but on the phase-1 shortlist it
 * returned unparseable JSON, and every task here needs structured output.
 *
 * Override any single task with ANTHROPIC_MODEL_<TASK> (e.g.
 * ANTHROPIC_MODEL_NARRATIVE), or all of them with ANTHROPIC_MODEL.
 * WARNING: any model used here MUST have a price row in lib/credits.ts.
 */
const AI_TASK_MODELS: Record<AiTask, string> = {
  discover: 'claude-sonnet-5-5',
  verify: 'claude-sonnet-5-5',
  'generate-form': 'claude-sonnet-5-5',
  'match-kb': 'claude-sonnet-5-5',
  'funding-summary': 'claude-sonnet-5-5',
  narrative: 'claude-opus-5-5',
  loi: 'claude-opus-5-5',
  polish: 'claude-opus-5-5',
  // Low volume (once per purpose) but its output shapes EVERY federal query and
  // AI discovery run afterwards, so it is worth the better model.
  'purpose-assist': 'claude-opus-5-5',
}

/**
 * Effort per task. Effort is the cost/latency dial now that thinking cannot be
 * switched off on 5.5 models. Measured on the discovery search: medium was
 * both faster and better than low (6.7s/6 results vs 9.5s/4), so cheap does
 * not mean low here — pick per task rather than globally.
 */
const AI_TASK_EFFORT: Record<AiTask, 'low' | 'medium' | 'high'> = {
  discover: 'medium',
  verify: 'medium', // accuracy matters most; a false positive reaches the user
  'generate-form': 'medium',
  'match-kb': 'low',
  'funding-summary': 'low',
  narrative: 'high', // the core deliverable
  loi: 'high',
  polish: 'medium',
  'purpose-assist': 'medium',
}

/** Env override name for one task: discover → ANTHROPIC_MODEL_DISCOVER. */
function envKeyFor(task: AiTask): string {
  return `ANTHROPIC_MODEL_${task.replace(/-/g, '_').toUpperCase()}`
}

export function modelFor(task: AiTask): string {
  return (
    process.env[envKeyFor(task)] ||
    process.env.ANTHROPIC_MODEL ||
    AI_TASK_MODELS[task]
  )
}

/**
 * Models that REJECT `thinking:{type:'adaptive'}` and need the old
 * enabled/disabled shape. Everything from the 4.6 generation on is adaptive;
 * Haiku 4.5 and earlier are not.
 */
function isAdaptiveThinkingModel(model: string): boolean {
  return !/haiku|claude-3|sonnet-4-5|sonnet-4-0/.test(model)
}

/**
 * The model + thinking + effort for one task, ready to spread into
 * `messages.create`. ALWAYS use this instead of writing `thinking` by hand —
 * the correct shape differs per model and getting it wrong is a hard 400.
 */
export function requestBaseFor(task: AiTask): {
  model: string
  thinking: { type: 'adaptive' } | { type: 'disabled' }
  output_config?: { effort: 'low' | 'medium' | 'high' }
} {
  const model = modelFor(task)
  if (!isAdaptiveThinkingModel(model)) {
    // Haiku-class: no adaptive thinking, and `effort` is not supported at all.
    return { model, thinking: { type: 'disabled' } }
  }
  return {
    model,
    thinking: { type: 'adaptive' },
    output_config: { effort: AI_TASK_EFFORT[task] },
  }
}

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
