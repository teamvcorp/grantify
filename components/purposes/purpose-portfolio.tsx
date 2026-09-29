'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/catalyst/badge'
import { Sparkles, Loader2, Check } from 'lucide-react'

interface FocusStat {
  term: string
  federal_hits: number
}

interface Proposal {
  purpose: {
    name: string
    description: string
    focus_areas: string[]
    geography: string
    target_amount: number
    grant_types: string[]
  }
  basis: string
  focus_area_stats: FocusStat[]
  /** Open federal opportunities this purpose would surface today. */
  federal_hits: number
  /** True when only a broadened query found anything — a weak signal. */
  federal_broadened: boolean
}

/**
 * Build a whole PORTFOLIO of purposes from the organization's mission.
 *
 * Most nonprofits run several programs at once, so the useful question is not
 * "describe one project" but "which of the things we already do should we chase
 * money for, and where is money actually available?" Each proposal is measured
 * against the live federal index before it is shown, and the list is ordered by
 * that measurement rather than by how good the wording sounds.
 */
export function PurposePortfolio({ onCreated }: { onCreated?: () => void }) {
  const [missionOnFile, setMissionOnFile] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Proposal[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [creating, setCreating] = useState(false)
  const [createdCount, setCreatedCount] = useState(0)
  const [missionSaved, setMissionSaved] = useState(false)

  // Check what we ALREADY know before asking the user to type anything.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ai/purpose-portfolio')
        const d = await res.json()
        if (res.ok && d.has_mission) setMissionOnFile(String(d.mission))
      } catch {
        // Non-fatal: fall back to asking for the mission.
      } finally {
        setChecking(false)
      }
    })()
  }, [])

  async function propose() {
    setLoading(true)
    setError(null)
    setProposals(null)
    setSelected(new Set())
    setCreatedCount(0)
    try {
      const res = await fetch('/api/ai/purpose-portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Omit `text` when a mission is on file — the server uses that.
        body: JSON.stringify(text.trim() ? { text: text.trim() } : {}),
      })
      const raw = await res.text()
      let d: {
        error?: string
        proposals?: Proposal[]
        mission_saved?: boolean
      } | null = null
      try {
        d = raw ? JSON.parse(raw) : null
      } catch {
        d = null
      }
      if (!res.ok || !d?.proposals) {
        throw new Error(d?.error || `Could not build purposes (HTTP ${res.status}).`)
      }
      setProposals(d.proposals)
      setMissionSaved(Boolean(d.mission_saved))
      // Pre-select everything that has real federal funding behind it.
      setSelected(
        new Set(
          d.proposals
            .map((p, i) => (p.federal_hits > 0 && !p.federal_broadened ? i : -1))
            .filter((i) => i >= 0)
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build purposes.')
    } finally {
      setLoading(false)
    }
  }

  function toggle(i: number) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  async function createSelected() {
    if (!proposals || selected.size === 0) return
    setCreating(true)
    setError(null)
    let made = 0
    try {
      for (const i of [...selected].sort((a, b) => a - b)) {
        const res = await fetch('/api/purposes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(proposals[i].purpose),
        })
        if (res.ok) made += 1
      }
      setCreatedCount(made)
      if (made > 0) {
        setProposals(null)
        setSelected(new Set())
        onCreated?.()
      }
      if (made < selected.size) {
        setError(`Created ${made} of ${selected.size}. The rest were rejected — try editing them.`)
      }
    } finally {
      setCreating(false)
    }
  }

  /** Availability label. The count alone is misleading when it came from broadening. */
  function availability(p: Proposal) {
    if (p.federal_hits < 0) return { color: 'zinc' as const, text: 'Federal: unknown' }
    if (p.federal_hits === 0) return { color: 'amber' as const, text: 'No federal match' }
    if (p.federal_broadened)
      return { color: 'amber' as const, text: `${p.federal_hits} federal (broad match)` }
    return { color: 'emerald' as const, text: `${p.federal_hits} open federal grants` }
  }

  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Sparkles className="h-4 w-4" /> Build purposes from your mission
          </h2>
          <p className="text-sm text-muted-foreground">
            Most organizations run several programs at once. Paste your mission and main programs
            and Claude proposes separate funding pipelines — each one checked against open federal
            grants before you see it, and ordered by what funding is actually available.
          </p>
          {/* The one-off path lives in the New purpose dialog and is easy to
              miss next to this panel. Point at it rather than letting someone
              conclude the portfolio builder is the only way to get AI help. */}
          <p className="pt-1 text-sm text-muted-foreground">
            Chasing a single specific project instead? Use{' '}
            <strong className="font-medium">New purpose</strong> — you can describe that one in
            plain English there.
          </p>
        </div>

        {checking ? (
          <p className="text-sm text-muted-foreground">Checking your organization details…</p>
        ) : missionOnFile ? (
          // Already on file — don't make them type it again.
          <div className="space-y-2 rounded-md border border-dashed p-3">
            <p className="text-xs font-medium">Using the mission on file</p>
            <p className="text-sm text-muted-foreground">{missionOnFile.slice(0, 400)}</p>
            <Label htmlFor="pp-extra" className="text-xs">
              Add or override (optional)
            </Label>
            <Textarea
              id="pp-extra"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Other programs you run, or a different emphasis for this round."
              rows={2}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="pp-text">
              Mission statement and programs <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="pp-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                'Our mission: "Building stronger futures, one neighbor at a time."\nPrograms we run: after-school robotics clubs, a food pantry, job readiness coaching for people leaving incarceration, emergency rental assistance, senior wellness checks.'
              }
              rows={5}
            />
            <p className="text-xs text-muted-foreground">
              Required — everything else is derived from it. We&apos;ll save it to your knowledge
              base so you only enter it once, and every other AI feature will use it too.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={propose}
            disabled={loading || checking || (!missionOnFile && text.trim().length < 20)}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Propose purposes
          </Button>
          {loading && (
            <span className="text-sm text-muted-foreground">
              Drafting, then checking each one against open federal grants…
            </span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {missionSaved && (
          <p className="text-xs text-muted-foreground">
            Saved your mission to the knowledge base — you won&apos;t need to enter it again.
          </p>
        )}
        {createdCount > 0 && (
          <p className="text-sm text-muted-foreground">
            Created {createdCount} {createdCount === 1 ? 'purpose' : 'purposes'}.
          </p>
        )}

        {proposals && proposals.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {proposals.length} proposed — ones with federal funding behind them are pre-selected.
            </p>

            {proposals.map((p, i) => {
              const a = availability(p)
              const isSelected = selected.has(i)
              return (
                <div
                  key={`${p.purpose.name}-${i}`}
                  className={`rounded-lg border p-3 ${isSelected ? 'border-primary' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.purpose.name}</span>
                        <Badge color={a.color}>{a.text}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{p.purpose.description}</p>
                      {p.basis && <p className="text-xs text-muted-foreground">{p.basis}</p>}
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {p.focus_area_stats.map((st) => (
                          <Badge
                            key={st.term}
                            color={
                              st.federal_hits < 0
                                ? 'zinc'
                                : st.federal_hits > 0
                                  ? 'emerald'
                                  : 'amber'
                            }
                          >
                            {st.term}
                            {st.federal_hits < 0 ? ' · ?' : ` · ${st.federal_hits}`}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {p.purpose.geography} · target $
                        {p.purpose.target_amount.toLocaleString()}
                        {p.purpose.grant_types.length > 0 &&
                          ` · ${p.purpose.grant_types.join(', ')}`}
                      </p>
                      {p.federal_hits === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No federal money for this one today — still worth creating if you want
                          AI discovery to hunt foundation and corporate funders for it.
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isSelected ? 'secondary' : 'outline'}
                      onClick={() => toggle(i)}
                    >
                      {isSelected ? <Check className="h-3.5 w-3.5" /> : null}
                      {isSelected ? 'Selected' : 'Select'}
                    </Button>
                  </div>
                </div>
              )
            })}

            <Button onClick={createSelected} disabled={creating || selected.size === 0}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create {selected.size} {selected.size === 1 ? 'purpose' : 'purposes'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
