'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Search, Loader2, ExternalLink, Sparkles } from 'lucide-react'

interface SearchResult {
  grantsgov_id: string
  number: string
  name: string
  funder: string
  funder_type: 'federal'
  status: string
  open_date: string | null
  deadline_full: string | null
  url: string
}

interface PurposeOption {
  id: string
  name: string
}

interface AiResult {
  name: string
  funder: string
  funder_type: 'federal' | 'foundation' | 'state' | 'corporate'
  amount_min: number | null
  amount_max: number | null
  deadline: string | null
  url: string
  focus_areas: string[]
  summary: string
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatAmount(min: number | null, max: number | null): string {
  const fmt = (n: number) => `$${n.toLocaleString()}`
  if (min != null && max != null) return `${fmt(min)} – ${fmt(max)}`
  if (max != null) return `up to ${fmt(max)}`
  if (min != null) return `from ${fmt(min)}`
  return 'Amount varies'
}

export function GrantSearch() {
  // --- Federal (Grants.gov) search ---
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [hitCount, setHitCount] = useState(0)

  // --- AI (Claude) discovery, tied to a Purpose ---
  const [purposes, setPurposes] = useState<PurposeOption[] | null>(null)
  const [purposeId, setPurposeId] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiResults, setAiResults] = useState<AiResult[] | null>(null)

  useEffect(() => {
    fetch('/api/purposes')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPurposes(d.purposes))
      .catch(() => setPurposes([]))
  }, [])

  async function runSearch(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/grants/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keyword.trim() || undefined, rows: 25 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed.')
      setResults(data.results)
      setHitCount(data.hitCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.')
      setResults(null)
    } finally {
      setLoading(false)
    }
  }

  async function runDiscovery() {
    if (!purposeId) return
    setAiLoading(true)
    setAiError(null)
    try {
      const res = await fetch('/api/ai/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose_id: purposeId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Discovery failed.')
      setAiResults(data.results)
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Discovery failed.')
      setAiResults(null)
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="space-y-10">
      {/* Federal search */}
      <section className="space-y-4">
        <form onSubmit={runSearch} className="flex gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="Search federal grants (e.g. affordable housing, education equity)"
            className="max-w-xl"
          />
          <Button type="submit" disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Search
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {results && (
          <p className="text-sm text-muted-foreground">
            {hitCount.toLocaleString()} matches on Grants.gov — showing {results.length}.
          </p>
        )}

        <div className="space-y-3">
          {results?.map((r) => (
            <Card key={r.grantsgov_id}>
              <CardContent className="flex items-start justify-between gap-4 py-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                    >
                      {r.name}
                      <ExternalLink className="ml-1 inline h-3 w-3 align-baseline" />
                    </a>
                    <Badge variant="secondary">Federal</Badge>
                    <Badge variant="outline">{r.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {r.funder} · #{r.number}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Closes {formatDate(r.deadline_full)}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {results && results.length === 0 && (
          <p className="text-sm text-muted-foreground">No opportunities matched.</p>
        )}
      </section>

      {/* AI discovery (foundation / state / corporate), tied to a Purpose */}
      <section className="space-y-4 border-t pt-8">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Sparkles className="h-4 w-4" /> AI discovery
          </h2>
          <p className="text-sm text-muted-foreground">
            Uses Claude with web search to find foundation, state, and corporate grants
            matching one of your purposes — the funders Grants.gov doesn&apos;t list.
          </p>
        </div>

        {purposes && purposes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No purposes yet. Create a purpose first, then discovery can match against it.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={purposeId}
              onChange={(e) => setPurposeId(e.target.value)}
              disabled={!purposes}
              className="h-9 rounded-md border bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="">
                {purposes ? 'Select a purpose…' : 'Loading purposes…'}
              </option>
              {purposes?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button onClick={runDiscovery} disabled={!purposeId || aiLoading}>
              {aiLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Discover with AI
            </Button>
          </div>
        )}

        {aiLoading && (
          <p className="text-sm text-muted-foreground">
            Searching the web and evaluating funders — this can take up to a minute…
          </p>
        )}
        {aiError && <p className="text-sm text-destructive">{aiError}</p>}

        <div className="space-y-3">
          {aiResults?.map((r, i) => (
            <Card key={`${r.url}-${i}`}>
              <CardContent className="space-y-1 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                  >
                    {r.name}
                    <ExternalLink className="ml-1 inline h-3 w-3 align-baseline" />
                  </a>
                  <Badge variant="secondary" className="capitalize">
                    {r.funder_type}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {r.funder} · {formatAmount(r.amount_min, r.amount_max)} · Closes{' '}
                  {formatDate(r.deadline)}
                </p>
                <p className="text-sm">{r.summary}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {aiResults && aiResults.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No strong matches found. Try refining the purpose&apos;s focus areas or geography.
          </p>
        )}
      </section>
    </div>
  )
}
