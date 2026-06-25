'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Search, Loader2, ExternalLink } from 'lucide-react'

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

function formatDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function GrantSearch() {
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [hitCount, setHitCount] = useState(0)

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

  return (
    <div className="space-y-4">
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

      {error && (
        <p className="text-sm text-destructive">
          {error}
        </p>
      )}

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
    </div>
  )
}
