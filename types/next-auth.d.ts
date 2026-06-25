import type { DefaultSession } from 'next-auth'

/**
 * Module augmentation so our custom JWT/session fields are type-checked everywhere.
 * These mirror what `lib/auth.ts` writes in its `jwt`/`session` callbacks:
 * the user's id, their tenant `org_id`, and their `role`.
 */

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      org_id: string
      role: string
    } & DefaultSession['user']
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string
    org_id?: string
    role?: string
  }
}
