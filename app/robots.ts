import type { MetadataRoute } from 'next'

const SITE_URL = 'https://www.getgrantify.com'

/**
 * Allow crawling the public landing page; keep the authenticated app, the API,
 * and the login page out of the index.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/login',
        '/dashboard',
        '/purposes',
        '/grants',
        '/knowledge-base',
        '/documents',
        '/settings',
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
