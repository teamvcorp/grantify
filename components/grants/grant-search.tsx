'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/catalyst/badge'
import { Select } from '@/components/catalyst/select'
import { Search, Loader2, ExternalLink, Sparkles, Plus, Check } from 'lucide-react'
import { funderColor } from '@/lib/ui'

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
  funder_type: 'federal' | 'foundation' | 'state' | 'corporate' | 'other'
  amount_min: number | null
  amount_max: number | null
  deadline_kind: 'fixed' | 'rolling'
  deadline: string | null
  url: string
  eligibility: string
  focus_areas: string[]
  summary: string
}

/** Grants.gov page size — must match the offset math used for pagination. */
const ROWS = 25

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

export function GrantSearch({ onImported }: { onImported?: () => void }) {
  // Shared: which purpose imports/discovery target.
  const [purposes, setPurposes] = useState<PurposeOption[] | null>(null)
  const [purposeId, setPurposeId] = useState('')

  // Per-result import tracking (keys: grantsgov_id for federal, url for AI).
  const [importingKey, setImportingKey] = useState<string | null>(null)
  const [importedKeys, setImportedKeys] = useState<Set<string>>(new Set())

  // Federal (Grants.gov) search.
  const [keyword, setKeyword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [hitCount, setHitCount] = useState(0)
  // 0-based page and the keyword that produced the current results, so Prev/Next
  // re-query the same search regardless of later edits to the input box.
  const [page, setPage] = useState(0)
  const [submittedKeyword, setSubmittedKeyword] = useState('')

  // AI (Claude) discovery.
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiResults, setAiResults] = useState<AiResult[] | null>(null)
  const [aiExcluded, setAiExcluded] = useState(0)

  useEffect(() => {
    fetch('/api/purposes')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setPurposes(d.purposes))
      .catch(() => setPurposes([]))
  }, [])

  async function importGrant(key: string, payload: Record<string, unknown>) {
    if (!purposeId) return
    setImportingKey(key)
    try {
      const res = await fetch('/api/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, purpose_id: purposeId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Import failed.')
      }
      setImportedKeys((s) => new Set(s).add(key))
      onImported?.()
    } catch {
      // Surface inline by leaving the button enabled; keep it lightweight.
    } finally {
      setImportingKey(null)
    }
  }

  // Run one page of the federal search. `pageArg` is 0-based; the offset sent to
  // Grants.gov is pageArg * ROWS (startRecordNum).
  async function doSearch(pageArg: number, kw: string) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/grants/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: kw || undefined,
          rows: ROWS,
          startRecordNum: pageArg * ROWS,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed.')
      setResults(data.results)
      setHitCount(data.hitCount)
      setPage(pageArg)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.')
      setResults(null)
    } finally {
      setLoading(false)
    }
  }

  function runSearch(e: React.FormEvent) {
    e.preventDefault()
    const kw = keyword.trim()
    setSubmittedKeyword(kw)
    void doSearch(0, kw) // a new search always starts on the first page
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
      // Read as text first: a platform 5xx (e.g. timeout) returns a non-JSON
      // body, which res.json() would choke on with a confusing parse error.
      const text = await res.text()
      let data: { error?: string; results?: AiResult[]; excluded_count?: number } | null = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (!res.ok || !data) {
        throw new Error(
          data?.error ||
            `Discovery failed (HTTP ${res.status})${res.status === 504 ? ' — the request timed out.' : ''}.`
        )
      }
      setAiResults(data.results ?? [])
      setAiExcluded(data.excluded_count ?? 0)
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Discovery failed.')
      setAiResults(null)
    } finally {
      setAiLoading(false)
    }
  }

  const noPurposes = purposes !== null && purposes.length === 0

  function ImportButton({ k, onClick }: { k: string; onClick: () => void }) {
    const done = importedKeys.has(k)
    return (
      <Button
        variant={done ? 'secondary' : 'outline'}
        size="sm"
        disabled={!purposeId || importingKey === k || done}
        onClick={onClick}
        title={!purposeId ? 'Select a purpose first' : undefined}
      >
        {importingKey === k ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : done ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        {done ? 'Imported' : 'Import'}
      </Button>
    )
  }

  return (
    <div className="space-y-8">
      {/* Shared target purpose for import + AI discovery */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Import into:</span>
        <Select
          value={purposeId}
          onChange={(e) => setPurposeId(e.target.value)}
          disabled={!purposes || noPurposes}
          aria-label="Purpose"
          className="sm:w-72"
        >
          <option value="">
            {noPurposes ? 'No purposes — create one first' : 'Select a purpose…'}
          </option>
          {purposes?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>

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
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {results && results.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {hitCount.toLocaleString()} matches on Grants.gov — showing{' '}
            {(page * ROWS + 1).toLocaleString()}–
            {(page * ROWS + results.length).toLocaleString()}.
          </p>
        )}

        <div className="space-y-3">
          {results?.map((r) => (
            <Card key={r.grantsgov_id}>
              <CardContent className="flex items-start justify-between gap-4 py-4">
                <div className="min-w-0 space-y-1">
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
                    <Badge color="blue">Federal</Badge>
                    <Badge color="zinc">{r.status}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {r.funder} · #{r.number}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Closes {formatDate(r.deadline_full)}
                  </p>
                </div>
                <ImportButton
                  k={r.grantsgov_id}
                  onClick={() =>
                    importGrant(r.grantsgov_id, {
                      name: r.name,
                      funder: r.funder,
                      funder_type: 'federal',
                      deadline_full: r.deadline_full,
                      url: r.url,
                      grantsgov_id: r.grantsgov_id,
                      discovered_by: 'ai',
                    })
                  }
                />
              </CardContent>
            </Card>
          ))}
        </div>

        {results && results.length > 0 && hitCount > ROWS && (
          <div className="flex items-center justify-between gap-4 pt-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || page === 0}
              onClick={() => doSearch(page - 1, submittedKeyword)}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {Math.ceil(hitCount / ROWS).toLocaleString()}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || (page + 1) * ROWS >= hitCount}
              onClick={() => doSearch(page + 1, submittedKeyword)}
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Next
            </Button>
          </div>
        )}

        {results && results.length === 0 && (
          <p className="text-sm text-muted-foreground">No opportunities matched.</p>
        )}
      </section>

      {/* AI discovery */}
      <section className="space-y-4 border-t pt-8">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Sparkles className="h-4 w-4" /> AI discovery
          </h2>
          <p className="text-sm text-muted-foreground">
            Uses Claude to find foundation, state, corporate, and other private grants Grants.gov
            doesn&apos;t list. Each result is <strong>verified against its real funder page</strong>{' '}
            and matched to your organization&apos;s profile — anything that can&apos;t be confirmed to
            a live link, deadline, and eligibility is excluded rather than shown.
          </p>
        </div>

        <Button onClick={runDiscovery} disabled={!purposeId || aiLoading}>
          {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Discover with AI
        </Button>

        {aiLoading && (
          <p className="text-sm text-muted-foreground">
            Searching, opening funder pages, and verifying each match — this can take a minute or
            two…
          </p>
        )}
        {aiError && <p className="text-sm text-destructive">{aiError}</p>}

        {aiResults && aiResults.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {aiResults.length} verified {aiResults.length === 1 ? 'match' : 'matches'}
            {aiExcluded > 0 && ` — ${aiExcluded} excluded for insufficient detail`}.
          </p>
        )}

        <div className="space-y-3">
          {aiResults?.map((r, i) => {
            const key = `${r.url}-${i}`
            return (
              <Card key={key}>
                <CardContent className="flex items-start justify-between gap-4 py-4">
                  <div className="min-w-0 space-y-1">
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
                      <Badge color={funderColor(r.funder_type)} className="capitalize">
                        {r.funder_type}
                      </Badge>
                      <Badge color="emerald">Verified</Badge>
                      {r.deadline_kind === 'rolling' && <Badge color="sky">Rolling</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {r.funder} · {formatAmount(r.amount_min, r.amount_max)} ·{' '}
                      {r.deadline_kind === 'rolling'
                        ? 'Rolling / year-round'
                        : `Closes ${formatDate(r.deadline)}`}
                    </p>
                    <p className="text-sm">{r.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium">Eligibility:</span> {r.eligibility}
                    </p>
                  </div>
                  <ImportButton
                    k={key}
                    onClick={() =>
                      importGrant(key, {
                        name: r.name,
                        funder: r.funder,
                        funder_type: r.funder_type,
                        amount_min: r.amount_min ?? 0,
                        amount_max: r.amount_max ?? 0,
                        // Only a fixed date maps to a deadline; rolling stays open.
                        deadline_full: r.deadline_kind === 'fixed' ? r.deadline : null,
                        url: r.url,
                        focus_areas: r.focus_areas,
                        notes: r.summary,
                        // Real eligibility/requirements from the verified page — the
                        // form + narrative tools read this (not the short summary).
                        requirements_raw: r.eligibility,
                        discovered_by: 'ai',
                      })
                    }
                  />
                </CardContent>
              </Card>
            )
          })}
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
