'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/lib/auth'
import { orgs, users } from '@/lib/collections'
import { getDb } from '@/lib/mongodb'
import { hashPassword } from '@/lib/password'
import { RegisterInput } from '@/lib/schemas'

/**
 * Server action backing the public registration form. Creates a brand-new org
 * (tenant) with the registrant as its first admin, then auto-signs them in.
 *
 * SECURITY:
 *  - Password is scrypt-hashed (lib/password); plaintext is never stored.
 *  - The unique `email` index is ensured before insert so two concurrent
 *    signups can't create duplicate logins; a duplicate-key rolls back the org.
 *  - A hidden honeypot field ("company_website") blocks trivial bots.
 *  - Errors are generic; the only unavoidable disclosure is "email already
 *    exists" (standard signup UX).
 *  - TODO (prod): add IP rate limiting (e.g. Upstash) — no rate-limit infra yet.
 *
 * On success `signIn` throws a NEXT_REDIRECT we must let propagate.
 */
export async function register(
  _prevState: string | undefined,
  formData: FormData
): Promise<string | undefined> {
  // Honeypot — a real person never fills this hidden field.
  if (((formData.get('company_website') as string) || '').trim()) {
    return 'Something went wrong. Please try again.'
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
