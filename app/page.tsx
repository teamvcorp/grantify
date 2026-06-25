import Link from 'next/link'
import {
  Search,
  Sparkles,
  FileText,
  BookOpen,
  LayoutDashboard,
  Mail,
  ArrowRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Public marketing landing page — the indexable entry at getgrantify.com.
 * Kept as a Server Component (no client JS) so it's fast and crawlable. The
 * authenticated app lives behind /login → /dashboard.
 */

const SITE_URL = 'https://www.getgrantify.com'

const FEATURES = [
  {
    icon: Search,
    title: 'Grant discovery',
    body: 'Search live federal opportunities from Grants.gov, plus AI discovery for foundation, state, and corporate funders.',
  },
  {
    icon: Sparkles,
    title: 'AI application forms',
    body: "Turn a funder's requirements into a structured application form in seconds.",
  },
  {
    icon: BookOpen,
    title: 'Knowledge-base auto-fill',
    body: 'Reuse your best answers. AI matches your knowledge base to each application field.',
  },
  {
    icon: FileText,
    title: 'Narrative drafting',
    body: 'Generate a grounded, persuasive narrative from your answers — streamed as it writes.',
  },
  {
    icon: LayoutDashboard,
    title: 'Pipeline & budgets',
    body: 'Track every grant by status and phase, build budgets, and store documents in one place.',
  },
  {
    icon: Mail,
    title: 'Share & submit',
    body: 'Export to PDF or email a complete application to your team or reviewers.',
  },
]

const PARENT_URL = 'https://www.thevacorp.com'

// Two linked entities: Grantify (the org/app) and its parent, The VA Corp.
// `parentOrganization` + `sameAs` tell search engines the two are related.
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'Grantify',
      url: SITE_URL,
      description: 'AI-assisted grant management for nonprofits.',
      parentOrganization: {
        '@type': 'Organization',
        name: 'The VA Corp',
        url: PARENT_URL,
      },
      sameAs: [PARENT_URL],
    },
    {
      '@type': 'SoftwareApplication',
      name: 'Grantify',
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: SITE_URL,
      description:
        'AI-assisted grant management for nonprofits: discover, track, and write grants from discovery to submission.',
      publisher: { '@id': `${SITE_URL}/#organization` },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
  ],
}

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Header */}
      <header className="flex h-16 items-center justify-between border-b px-6">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            G
          </span>
          Grantify
        </span>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm" render={<Link href="/login" />}>
            Sign in
          </Button>
          <Button size="sm" render={<Link href="/login" />}>
            Get started
          </Button>
        </nav>
      </header>

      {/* Hero */}
      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            From grant discovery to submission — in a week, not a quarter
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
            Grantify is AI-assisted grant management for nonprofits. Find the right funders,
            auto-build application forms, draft narratives from your knowledge base, and track
            every grant in one pipeline.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Button size="lg" render={<Link href="/login" />}>
              Get started <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="lg" render={<Link href="/login" />}>
              Sign in
            </Button>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-5xl px-6 pb-24">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border p-5">
                <Icon className="h-5 w-5 text-primary" />
                <h2 className="mt-3 font-medium">{title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="space-y-1 border-t px-6 py-8 text-center text-sm text-muted-foreground">
        <p>© {new Date().getFullYear()} Grantify · AI-assisted grant management for nonprofits</p>
        <p>
          A project of{' '}
          <a
            href="https://www.thevacorp.com"
            className="font-medium underline-offset-4 hover:underline"
          >
            The VA Corp
          </a>
        </p>
      </footer>
    </div>
  )
}
