import { ObjectId } from 'mongodb'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DollarSign, FileText, CalendarClock, Award } from 'lucide-react'
import { auth } from '@/lib/auth'
import { grants } from '@/lib/collections'
import type { Grant } from '@/lib/types'

/**
 * Live dashboard aggregates over the org's grants.
 * DB-backed → must be dynamic so `next build` never tries to connect (NOTES.md).
 */
export const dynamic = 'force-dynamic'

const ACTIVE_STATUSES = ['discovered', 'reviewing', 'active', 'submitted']
const DEAD_STATUSES = ['rejected', 'archived']

function fmtMoney(n: number): string {
  return n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n}`
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return <p className="text-sm text-destructive">Not authenticated.</p>
  }

  const col = await grants()
  const docs = (await col
    .find({ org_id: new ObjectId(session.user.org_id) })
    .toArray()) as Grant[]

  const now = new Date()
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
  const yearStart = new Date(now.getFullYear(), 0, 1)

  const pipelineValue = docs
    .filter((g) => !DEAD_STATUSES.includes(g.status))
    .reduce((sum, g) => sum + (g.amount_max || g.amount_min || 0), 0)

  const activeCount = docs.filter((g) => ACTIVE_STATUSES.includes(g.status)).length

  const upcoming = docs
    .filter((g) => g.deadline_full && g.deadline_full >= now && g.deadline_full <= in30)
    .sort((a, b) => a.deadline_full!.getTime() - b.deadline_full!.getTime())

  const awardedYtd = docs.filter(
    (g) => g.status === 'awarded' && g.updated_at >= yearStart
  ).length

  const stats = [
    { label: 'Total pipeline value', value: fmtMoney(pipelineValue), icon: DollarSign },
    { label: 'Active grants', value: String(activeCount), icon: FileText },
    { label: 'Due in 30 days', value: String(upcoming.length), icon: CalendarClock },
    { label: 'Awarded YTD', value: String(awardedYtd), icon: Award },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Your grant pipeline at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {label}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deadlines (next 30 days)</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {upcoming.length === 0 ? (
            <p className="text-muted-foreground">
              No deadlines in the next 30 days. Head to{' '}
              <span className="font-medium text-foreground">Grants</span> to find and import
              opportunities.
            </p>
          ) : (
            <ul className="divide-y">
              {upcoming.map((g) => (
                <li key={g._id!.toString()} className="flex justify-between gap-4 py-2">
                  <span className="min-w-0 truncate">{g.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {fmtDate(g.deadline_full!)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
