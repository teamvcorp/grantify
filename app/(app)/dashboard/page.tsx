import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DollarSign, FileText, CalendarClock, Award } from 'lucide-react'

/**
 * Dashboard shell. Stat values are placeholders for the first deployable
 * version — they'll be wired to live aggregates over the `grants` collection
 * (scoped by org_id) once auth + seed data are in place.
 */

const STATS = [
  { label: 'Total pipeline value', value: '—', icon: DollarSign },
  { label: 'Active grants', value: '—', icon: FileText },
  { label: 'Due this month', value: '—', icon: CalendarClock },
  { label: 'Awarded YTD', value: '—', icon: Award },
] as const

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your grant pipeline at a glance.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map(({ label, value, icon: Icon }) => (
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
        <CardContent className="text-sm text-muted-foreground">
          No grants in your pipeline yet. Head to{' '}
          <span className="font-medium text-foreground">Grants</span> to search
          live federal opportunities from Grants.gov.
        </CardContent>
      </Card>
    </div>
  )
}
