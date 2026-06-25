import { handlers } from '@/lib/auth'

/**
 * NextAuth v5 catch-all route. The library generates the GET/POST handlers for
 * every auth endpoint (sign-in, callback, session, csrf, signout, etc.).
 */
export const { GET, POST } = handlers
