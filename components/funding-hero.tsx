'use client'

import { useEffect, useState } from 'react'

interface FundingStat {
  label: string
  amount: number
  open_count: number
}

function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`
  return `$${Math.round(n)}`
}

/**
 * Rolling funding hero: cycles through funding categories, counting the dollar
 * figure up from zero each time. Pure client animation (no deps).
 */
export function FundingHero({ stats }: { stats: FundingStat[] }) {
  const [i, setI] = useState(0)
  const [display, setDisplay] = useState(stats[0]?.amount ?? 0)

  // Advance to the next category on an interval.
  useEffect(() => {
    if (stats.length <= 1) return
    const id = setInterval(() => setI((p) => (p + 1) % stats.length), 3800)
    return () => clearInterval(id)
  }, [stats.length])

  // Count up to the current category's amount.
  useEffect(() => {
    const target = stats[i]?.amount ?? 0
    let raf = 0
    let startedAt = 0
    const duration = 1000
    const step = (t: number) => {
      if (!startedAt) startedAt = t
      const p = Math.min((t - startedAt) / duration, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      setDisplay(Math.round(target * eased))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [i, stats])

  const current = stats[i]
  const total = stats.reduce((s, x) => s + x.amount, 0)

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Federal grant funding available now
      </p>
      <div className="text-5xl font-bold tabular-nums text-primary sm:text-6xl">
        {fmtMoney(display)}
      </div>
      <p className="text-lg font-medium">
        available in{' '}
        <span className="text-primary transition-colors">{current?.label ?? 'grants'}</span>
        {current?.open_count ? (
          <span className="text-muted-foreground"> · {current.open_count.toLocaleString()} open grants</span>
        ) : null}
      </p>
      <p className="text-sm text-muted-foreground">
        {fmtMoney(total)}+ tracked across every category — how much of it will be yours?
      </p>
    </div>
  )
}
