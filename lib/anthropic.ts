import Anthropic from '@anthropic-ai/sdk'

/**
 * Anthropic client + shared config.
 *
 * BUILD-SAFE: the client is created lazily so a missing ANTHROPIC_API_KEY can't
 * throw during `next build`. All AI calls are server-side only — this module
 * must never be imported into a client component (the key would leak into the
 * browser bundle).
 *
 * MODEL CHOICE: the spec pinned claude-sonnet-4-6 (good cost/quality for
 * high-volume grant generation). It's a single constant here so you can switch
 * to claude-opus-4-8 (more capable) by changing one line or the env var.
 */

export const GRANT_OS_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

/** Latest web search tool variant (dynamic filtering) — supported on Sonnet 4.6. */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20260209' as const,
  name: 'web_search' as const,
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
