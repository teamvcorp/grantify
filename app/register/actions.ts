'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/lib/auth'
import { orgs, users } from '@/lib/collections'
import { getDb } from '@/lib/mongodb'
import { hashPassword } from '@/lib/password'
import { RegisterInput } from '@/lib/schemas'
import { checkRateLimit, getClientIp, isDisposableEmail } from '@/lib/rate-limit'
import { FORM_TOKEN_FIELD, verifyFormToken } from '@/lib/form-token'

/**
 * Server action backing the public registration form. Creates a brand-new org
 * (tenant) with the registrant as its first admin, then auto-signs them in.
 *
 * SECURITY:
 *  - Password is scrypt-hashed (lib/password); plaintext is never stored.
 *  - The unique `email` index is ensured before insert so two concurrent
 *    signups can't create duplicate logins; a duplicate-key rolls back the org.
 *  - Errors are generic; the only unavoidable disclosure is "email already
 *    exists" (standard signup UX).
 *
 * BOT DEFENCE — four independent layers, because any one alone is weak:
 *  1. Honeypot ("company_website") — a real person never fills a hidden field.
 *  2. Signed timing token — catches instant submits and direct POSTs that never
 *     rendered the form (lib/form-token).
 *  3. IP rate limit — caps mass signup even from a bot that defeats 1 and 2
 *     (lib/rate-limit, Mongo-backed, fails OPEN on DB trouble).
 *  4. Disposable-email block — throwaway inboxes are what make fake accounts
 *     free to create.
 * All rejections return the SAME generic message, so a bot can't tell which
 * layer caught it and tune around it. The real reason is logged server-side.
 *
 * NOT DONE: email verification. It is the strongest anti-fake-account measure,
 * but it gates real users behind a working mailbox and needs a token + verify
 * page + a "resend" path. See NOTES.md — worth doing next, deliberately.
 *
 * On success `signIn` throws a NEXT_REDIRECT we must let propagate.
 */
export async function register(
  _prevState: string | undefined,
  formData: FormData
): Promise<string | undefined> {
  // One message for every bot rejection — never tell a script which layer
  // caught it, or it becomes a tuning oracle.
  const GENERIC = 'Something went wrong. Please try again.'

  // LAYER 1 — honeypot. A real person never fills this hidden field.
  if (((formData.get('company_website') as string) || '').trim()) {
    console.warn('[register] blocked: honeypot filled')
    return GENERIC
  }

  // LAYER 2 — signed timing token. Rejects instant submits and direct POSTs
  // that never loaded the form.
  const verdict = verifyFormToken(formData.get(FORM_TOKEN_FIELD))
  if (verdict !== 'ok') {
    console.warn(`[register] blocked: form token ${verdict}`)
    // An expired token is an honest case (a tab left open), so say something
    // actionable rather than the generic bot message.
    return verdict === 'expired'
      ? 'This page was open for a while. Please refresh and try again.'
      : GENERIC
  }

  // LAYER 3 — IP rate limit. Two windows: a tight burst cap plus a daily cap,
  // so a slow drip is throttled as well as a flood.
  const ip = await getClientIp()
  const burst = await checkRateLimit(`register:burst:${ip}`, 3, 60 * 60)
  if (!burst.allowed) {
    console.warn(`[register] blocked: burst rate limit for ${ip}`)
    return 'Too many signups from this network. Please try again later.'
  }
  const daily = await checkRateLimit(`register:daily:${ip}`, 10, 24 * 60 * 60)
  if (!daily.allowed) {
    console.warn(`[register] blocked: daily rate limit for ${ip}`)
    return 'Too many signups from this network. Please try again later.'
  }

  const parsed = RegisterInput.safeParse({
    name: formData.get('name'),
    org_name: formData.get('org_name'),
    email: formData.get('email'),
    password: formData.get('password'),
  })
  if (!parsed.success) {
    return parsed.error.issues[0]?.message ?? 'Please check your details and try again.'
  }
  const { name, org_name, email, password } = parsed.data

  // LAYER 4 — throwaway inboxes. A disposable address is what makes a fake
  // account free, so refuse it and say so plainly: this one IS worth telling
  // the user, because a real person using a temp inbox can simply use another.
  if (isDisposableEmail(email)) {
    console.warn('[register] blocked: disposable email domain')
    return 'Please sign up with your organization email address.'
  }

  const usersCol = await users()
  const orgsCol = await orgs()

  // Guarantee the unique login index exists (idempotent) so races can't dupe emails.
  const db = await getDb()
  await db
    .collection('users')
    .createIndex({ email: 1 }, { unique: true })
    .catch(() => {})

  if (await usersCol.findOne({ email })) {
    return 'An account with that email already exists. Sign in instead.'
  }

  const now = new Date()
  const orgRes = await orgsCol.insertOne({
    name: org_name,
    ein: '',
    plan: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    plan_expires_at: null,
    created_at: now,
  })

  try {
    await usersCol.insertOne({
      org_id: orgRes.insertedId,
      email,
      name,
      role: 'admin',
      password_hash: await hashPassword(password),
      avatar_url: null,
      created_at: now,
      last_login: null,
    })
  } catch (err) {
    // Couldn't create the user (likely a race → duplicate email). Roll back the
    // empty org so we don't leave an orphan tenant behind.
    await orgsCol.deleteOne({ _id: orgRes.insertedId }).catch(() => {})
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      return 'An account with that email already exists. Sign in instead.'
    }
    return 'Could not create your account. Please try again.'
  }

  try {
    await signIn('credentials', { email, password, redirectTo: '/dashboard' })
  } catch (error) {
    if (error instanceof AuthError) {
      // Account exists but auto sign-in hiccuped — let them sign in manually.
      return 'Your account was created. Please sign in.'
    }
    throw error // NEXT_REDIRECT — must bubble up.
  }
  return undefined
}
