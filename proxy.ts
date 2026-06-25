import { auth } from '@/lib/auth'

/**
 * Route protection (Next.js 16 renamed the `middleware` convention to `proxy`).
 * Runs on the Node.js runtime, so importing the NextAuth config (which pulls in
 * the MongoDB driver via the credentials provider) is safe here.
 *
 * `auth(...)` wraps the handler and exposes the decoded session on `req.auth`
 * (JWT verification only — the DB is not touched during this check).
 */

// Authenticated app surface — the routes in the app/(app) group.
const PROTECTED = [
  '/dashboard',
  '/purposes',
  '/grants',
  '/knowledge-base',
  '/documents',
  '/settings',
]

export default auth((req) => {
  const { pathname } = req.nextUrl
  const loggedIn = !!req.auth
  const isProtected = PROTECTED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`)
  )

  if (isProtected && !loggedIn) {
    return Response.redirect(new URL('/login', req.nextUrl))
  }
  // Already signed in? Skip the login page.
  if (pathname === '/login' && loggedIn) {
    return Response.redirect(new URL('/dashboard', req.nextUrl))
  }
})

// API routes enforce auth themselves (returning 401), so exclude them here —
// a proxy redirect to /login would be wrong for an API caller.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
