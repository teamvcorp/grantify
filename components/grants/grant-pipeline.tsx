'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Trash2, ExternalLink } from 'lucide-react'
import { GRANT_STATUSES } from '@/lib/schemas'

interface Grant {
  id: string
  name: string
  funder: string
  funder_type: string
  amount_min: number
  amount_max: number
  status: string
  phase: number
  deadline_full: string | null
  url: string
  discovered_by: string
}

const STATUS_LABELS: Record<string, string> = {
  discovered: 'Discovered',
  reviewing: 'Reviewing',
  active: 'Active',
  submitted: 'Submitted',
  awarded: 'Awarded',
  rejected: 'Rejected',
  archived: 'Archived',
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatAmount(min: number, max: number): string {
  if (!min && !max) return 'Amount varies'
  const fmt = (n: number) => `$${n.toLocaleString()}`
  if (min && max) return `${fmt(min)} – ${fmt(max)}`
  return fmt(max || min)
}

export function GrantPipeline({ version }: { version: number }) {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/grants')
      if (!res.ok) throw new Error('Could not load pipeline.')
      const data = await res.json()
      setGrants(data.grants)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pipeline.')
      setGrants([])
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load, version])

  async function patch(id: string, body: Record<string, unknown>) {
    // Optimistic update.
    setGrants((gs) => gs && gs.map((g) => (g.id === id ? { ...g, ...body } : g)))
    const res = await fetch(`/api/grants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) load() // revert to server truth on failure
  }

  async function remove(g: Grant) {
    if (!confirm(`Remove "${g.name}" from the pipeline?`)) return
    setGrants((gs) => gs && gs.filter((x) => x.id !== g.id))
    const res = await fetch(`/api/grants/${g.id}`, { method: 'DELETE' })
    if (!res.ok) load()
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (grants === null) return <p className="text-sm text-muted-foreground">Loading pipeline…</p>
  if (grants.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No grants in your pipeline yet. Find and import opportunities below.
        </CardContent>
      </Card>
    )
  }

  const byStatus = GRANT_STATUSES.map((s) => ({
    status: s,
    items: grants.filter((g) => g.status === s),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="space-y-6">
      {byStatus.map(({ status, items }) => (
        <div key={status} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">
            {STATUS_LABELS[status]} · {items.length}
          </h3>
          <div className="space-y-2">
            {items.map((g) => (
              <Card key={g.id}>
                <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/grants/${g.id}`} className="font-medium hover:underline">
                        {g.name}
                      </Link>
                      {g.url && (
                        <a
                          href={g.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="Open funder page"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      <Badge variant="secondary" className="capitalize">
                        {g.funder_type}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {g.funder || 'Unknown funder'} · {formatAmount(g.amount_min, g.amount_max)} ·
                      Closes {formatDate(g.deadline_full)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <select
                      value={g.status}
                      onChange={(e) => patch(g.id, { status: e.target.value })}
                      className="h-7 rounded-md border bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label="Status"
                    >
                      {GRANT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                    <select
                      value={g.phase}
                      onChange={(e) => patch(g.id, { phase: Number(e.target.value) })}
                      className="h-7 rounded-md border bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label="Phase"
                    >
                      {[1, 2, 3, 4, 5, 6].map((p) => (
                        <option key={p} value={p}>
                          Phase {p}
                        </option>
                      ))}
                    </select>
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(g)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Remove</span>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
