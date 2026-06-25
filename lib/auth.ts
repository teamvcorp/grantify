import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import Google from 'next-auth/providers/google'
import { z } from 'zod'
import type { Provider } from 'next-auth/providers'
import { users } from './collections'
import { verifyPassword } from './password'

/**
 * NextAuth v5 (Auth.js) configuration — the single source of auth truth.
 *
 * BUILD-SAFE: `NextAuth(...)` does not connect to the DB or read secrets at import
 * time (AUTH_SECRET is only required when a request is actually handled), so this
 * module is safe to import during `next build` before env vars exist. The DB is
 * touched only inside `authorize`, which runs on credential sign-in.
 *
 * SESSIONS: JWT strategy (no DB session table). We mint `id`, `org_id`, and `role`
 * into the token on sign-in and surface them on `session.user` — every org-scoped
 * query downstream filters by `session.user.org_id` (see NOTES.md multi-tenancy rule).
 *
 * SERVER-ONLY: never import this into a client component.
 */

const credentialsSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
})

// Google is optional — only wire it when both halves of the credential are set,
// otherwise NextAuth would render a broken provider button.
const googleEnabled = Boolean(
  process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
)

const providers: Provider[] = [
  Credentials({
    credentials: {
      email: { label: 'Email', type: 'email' },
      password: { label: 'Password', type: 'password' },
    },
    authorize: async (raw) => {
      // Returning null => NextAuth surfaces a generic CredentialsSignin error.
      // We never reveal whether the email exists vs. the password was wrong.
      const parsed = credentialsSchema.safeParse(raw)
      if (!parsed.success) return null
      const { email, password } = parsed.data

      const col = await users()
      const user = await col.findOne({ email })
      if (!user || !user.password_hash) return null

      const ok = await verifyPassword(password, user.password_hash)
      if (!ok) return null

      // Best-effort last_login stamp; don't fail the login if this write hiccups.
      await col
        .updateOne({ _id: user._id }, { $set: { last_login: new Date() } })
        .catch(() => {})

      return {
        id: user._id!.toString(),
        email: user.email,
        name: user.name,
        org_id: user.org_id.toString(),
        role: user.role,
      }
    },
  }),
  ...(googleEnabled ? [Google] : []),
]

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers,
  callbacks: {
    // Persist tenant + role onto the JWT at sign-in; subsequent calls just pass it through.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.org_id = (user as { org_id?: string }).org_id
        token.role = (user as { role?: string }).role
      }
      return token
    },
    // Expose the same fields on the session consumed by server components / DAL.
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.org_id = token.org_id as string
        session.user.role = token.role as string
      }
      return session
    },
  },
})
