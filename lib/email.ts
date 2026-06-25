import { Resend } from 'resend'

/**
 * Resend email client — BUILD-SAFE (lazy, like the Mongo/Anthropic/Stripe clients).
 * Reads RESEND_API_KEY only at call time so a missing key can't throw during
 * `next build`. Until both RESEND_API_KEY and RESEND_FROM are set,
 * `emailConfigured()` is false and senders should no-op or 503. Server-only.
 *
 * RESEND_FROM must use a domain verified in Resend (e.g. "Grant OS <grants@fyht4.com>").
 */

let client: Resend | undefined

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM)
}

function getResend(): Resend {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not set. Email is not configured.')
  }
  if (!client) client = new Resend(process.env.RESEND_API_KEY)
  return client
}

export interface SendEmailOptions {
  to: string | string[]
  subject: string
  html: string
  replyTo?: string
}

/** Send an email via Resend. Throws on a missing FROM or a provider error. */
export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const from = process.env.RESEND_FROM
  if (!from) throw new Error('RESEND_FROM is not set.')

  const { error } = await getResend().emails.send({
    from,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
    replyTo: opts.replyTo,
  })
  if (error) {
    throw new Error(error.message || 'Email send failed.')
  }
}
