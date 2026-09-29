import { createFormToken } from '@/lib/form-token'
import { RegisterForm } from './register-form'

/**
 * MUST stay dynamic. The form carries a signed timestamp minted at render; if
 * this page were prerendered at build time every visitor would share one stale
 * token and, six hours after deploy, EVERY signup would be rejected as expired.
 */
export const dynamic = 'force-dynamic'

export default function RegisterPage() {
  return <RegisterForm formToken={createFormToken()} />
}
