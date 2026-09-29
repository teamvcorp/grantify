import { headers } from 'next/headers'
import { getDb } from './mongodb'

/**
 * Abuse throttling, backed by MongoDB (no extra infrastructure).
 *
 * Fixed-window counters in a `rate_limits` collection with a TTL index, so old
 * windows delete themselves and the collection never grows.
 *
 * FAILS OPEN, DELIBERATELY. If Mongo is slow or unreachable, `check()` ALLOWS
 * the request and logs. A rate limiter that fails closed on a database blip
 * would lock every real user out of sign-in — a self-inflicted outage far worse
 * than the abuse it prevents. Availability wins here; the honeypot, timing
 * check and email rules in the register action still apply.
 *
 * Fixed windows let a caller burst across a boundary (up to 2x the limit over
 * two adjacent windows). That is a known, accepted trade for the simplicity;
 * the limits below are set low enough that the burst is still harmless.
 */

const COLLECTION = 'rate_limits'

let indexReady: Promise<void> | null = null

/** Ensure the TTL index once per process (idempotent, cached). */
function ensureIndex(): Promise<void> {
  if (!indexReady) {
    indexReady = (async () => {
      const db = await getDb()
      await db
        .collection(COLLECTION)
        .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 })
    })().catch(() => {
      // Let a later call retry rather than caching the failure forever.
      indexReady = null
    })
  }
  return indexReady
}

export interface RateLimitResult {
  allowed: boolean
  /** Attempts remaining in this window (0 when blocked). */
  remaining: number
  /** Roughly how long until the window resets, in seconds. */
  retryAfterSeconds: number
}

/**
 * Count one hit against `key` and report whether it is allowed.
 *
 * @param key    Stable identifier, e.g. `register:ip:1.2.3.4`. Include the
 *               action name so different actions never share a budget.
 * @param limit  Maximum hits allowed per window.
 * @param windowSeconds Window length.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now()
  // Fixed window: everyone in the same slice shares a bucket id.
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000
  const resetAt = windowStart + windowSeconds * 1000
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))

  try {
    await ensureIndex()
    const db = await getDb()
    // Atomic increment — concurrent requests can't race past the limit.
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { _id: `${key}:${windowStart}` as unknown as never },
      {
        $inc: { count: 1 },
        $setOnInsert: { expires_at: new Date(resetAt) },
      },
      { upsert: true, returnDocument: 'after' }
    )
    const count = Number(doc?.count ?? 1)
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    }
  } catch (err) {
    // FAIL OPEN — see the note at the top of this file.
    console.warn('[rate-limit] check failed, allowing request:', err)
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 }
  }
}

/**
 * Read the current count for `key` WITHOUT incrementing it.
 *
 * Needed for login, where only FAILURES should count. If the check itself
 * incremented, a busy shared office IP would throttle its own successful
 * sign-ins. Also fails open.
 */
export async function peekRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000
  const resetAt = windowStart + windowSeconds * 1000
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000))
  try {
    const db = await getDb()
    const doc = await db
      .collection(COLLECTION)
      .findOne({ _id: `${key}:${windowStart}` as unknown as never })
    const count = Number(doc?.count ?? 0)
    return {
      allowed: count < limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds,
    }
  } catch (err) {
    console.warn('[rate-limit] peek failed, allowing request:', err)
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 }
  }
}

/**
 * Clear a key's current window. Called after a SUCCESSFUL login so a user who
 * mistyped a few times isn't left one attempt from a lockout for the rest of
 * the window.
 */
export async function resetRateLimit(key: string, windowSeconds: number): Promise<void> {
  const windowStart =
    Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000
  try {
    const db = await getDb()
    await db
      .collection(COLLECTION)
      .deleteOne({ _id: `${key}:${windowStart}` as unknown as never })
  } catch {
    // Non-fatal: the window expires on its own.
  }
}

/**
 * Best-effort client IP.
 *
 * On Vercel `x-forwarded-for` is set by the platform and its FIRST entry is the
 * real client, so we take that. Never trust this for anything security-critical
 * on its own: a client can send the header, and behind some proxies it can be
 * spoofed. It is good enough to throttle casual abuse, which is what it is for.
 * Falls back to a constant bucket so a missing header throttles globally rather
 * than silently disabling the limit.
 */
export async function getClientIp(): Promise<string> {
  try {
    const h = await headers()
    const forwarded = h.get('x-forwarded-for')
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim()
      if (first) return first
    }
    const real = h.get('x-real-ip')?.trim()
    if (real) return real
  } catch {
    // headers() is unavailable outside a request scope.
  }
  return 'unknown'
}

/**
 * Disposable / throwaway email domains. Blocking these is the cheapest way to
 * stop a bot minting endless "real looking" accounts, because a throwaway inbox
 * is what makes mass signup free.
 *
 * Deliberately a SHORT list of the highest-volume providers rather than an
 * exhaustive one: a huge list goes stale, costs more to maintain, and risks
 * blocking a legitimate nonprofit. Extend as abuse is actually observed.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  'sharklasers.com',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'getnada.com',
  'dispostable.com',
  'fakeinbox.com',
  'maildrop.cc',
  'mintemail.com',
  'mohmal.com',
  'spamgourmet.com',
  'tempinbox.com',
  'emailondeck.com',
  'mailnesia.com',
  'inboxbear.com',
  'tmpmail.org',
  'burnermail.io',
])

/** True when the address uses a known throwaway inbox provider. */
export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain) return false
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) return true
  // Catch the common "subdomain of a throwaway" trick (mail.yopmail.com).
  return [...DISPOSABLE_EMAIL_DOMAINS].some((d) => domain.endsWith(`.${d}`))
}
