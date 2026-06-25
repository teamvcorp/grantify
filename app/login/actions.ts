'use server'

import { AuthError } from 'next-auth'
import { signIn } from '@/lib/auth'

/**
 * Server action backing the login form. Returns an error string for the UI on
 * failure; on success `signIn` throws a NEXT_REDIRECT we must let propagate.
 */
export async function authenticate(
  _prevState: string | undefined,
  formData: FormData
): Promise<string | undefined> {
  try {
    await signIn('credentials', {
      email: formData.get('email'),
      password: formData.get('password'),
      redirectTo: '/dashboard',
    })
  } catch (error) {
    if (error instanceof AuthError) {
      // CredentialsSignin (and any other auth error) → generic message; never
      // reveal whether the email exists vs. the password was wrong.
      return 'Invalid email or password.'
    }
    // Redirects (and anything else) must bubble up.
    throw error
  }
}
