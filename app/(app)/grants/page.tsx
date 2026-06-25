import { GrantSearch } from '@/components/grants/grant-search'

export default function GrantsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Grants</h1>
        <p className="text-sm text-muted-foreground">
          Search live federal opportunities from Grants.gov, or use AI discovery to
          find foundation, state, and corporate grants matching one of your purposes.
        </p>
      </div>
      <GrantSearch />
    </div>
  )
}
