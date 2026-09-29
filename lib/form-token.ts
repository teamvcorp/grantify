import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed, time-stamped token embedded in public forms.
 *
 * Two bot signals in one field:
 *  1. HOW FAST the form was submitted. A human cannot read a signup form, type
 *     a name, org, email and password in under a couple of seconds; a script
 *     posting straight to the action does it instantly.
 *  2. WHETHER the form was ever rendered at all. A script that POSTs directly
 *     without loading the page has no valid token to send.
 *
 * The timestamp is HMAC-signed with AUTH_SECRET, so a bot cannot simply invent
 * an older timestamp to look human. This is a speed bump, not authentication —
 * it stops commodity signup bots, not a determined attacker who renders the
 * page. It is layered with a honeypot, IP rate limiting and disposable-domain
 * rules; no single one of these is meant to carry the whole load.
 */

/** Minimum plausible time for a human to complete the signup form. */
const MIN_FILL_MS = 2_500
/** Tokens older than this are stale (tab left open overnight, or replayed). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000 // 6 hours

const FIELD = 'form_started_at'
export const FORM_TOKEN_FIELD = FIELD

function secret(): string {
  // AUTH_SECRET is always present in any environment that can serve auth. Fall
  // back to a constant so a misconfigured preview deploy degrades to "no timing
  // check" instead of throwing on every render.
  return process.env.AUTH_SECRET || 'grantify-form-token-fallback'
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

/** Mint a token for a form being rendered now. */
export function createFormToken(now: number = Date.now()): string {
  const ts = String(now)
  return `${ts}.${sign(ts)}`
}

export type FormTokenVerdict = 'ok' | 'missing' | 'invalid' | 'too-fast' | 'expired'

/**
 * Validate a submitted token. Returns a verdict rather than a boolean so the
 * caller can log WHY something was rejected — without that, a legitimate user
 * blocked by a clock skew bug is invisible.
 */
export function verifyFormToken(
  raw: unknown,
  now: number = Date.now()
): FormTokenVerdict {
  if (typeof raw !== 'string' || !raw.includes('.')) return 'missing'
  const [ts, mac] = raw.split('.')
  if (!ts || !mac) return 'invalid'

  const expected = sign(ts)
  // Constant-time compare; timingSafeEqual throws on length mismatch.
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid'

  const started = Number(ts)
  if (!Number.isFinite(started)) return 'invalid'

  const age = now - started
  // A token from the future means a tampered or badly skewed clock.
  if (age < 0) return 'invalid'
  if (age < MIN_FILL_MS) return 'too-fast'
  if (age > MAX_AGE_MS) return 'expired'
  return 'ok'
}
