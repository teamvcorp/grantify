'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Plus, Minus } from 'lucide-react'
import { readApiJson } from '@/lib/ui'

/**
 * Buy AI credits: pick how many $5 units, then redirect to Stripe Checkout.
 * Only rendered for admins when billing is configured.
 */
export function BuyCredits() {
  const [units, setUnits] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function buy() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/billing/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ units }),
      })
      const data = await readApiJson<{ url: string }>(res, 'Checkout')
      if (data.url) window.location.href = data.url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed.')
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setUnits((u) => Math.max(1, u - 1))}
            disabled={busy || units <= 1}
          >
            <Minus className="h-3.5 w-3.5" />
            <span className="sr-only">Fewer</span>
          </Button>
          <span className="w-16 text-center text-sm tabular-nums">
            {units} × $5
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => setUnits((u) => Math.min(50, u + 1))}
            disabled={busy || units >= 50}
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="sr-only">More</span>
          </Button>
        </div>
        <Button onClick={buy} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Buy ${units * 5} in credits
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
