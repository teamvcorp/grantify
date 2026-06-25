import type { MetadataRoute } from 'next'

const SITE_URL = 'https://www.getgrantify.com'

/**
 * Only the public landing page is indexable; the rest of the app is behind auth
 * (and disallowed in robots). Add public marketing/blog routes here as they ship.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ]
}
