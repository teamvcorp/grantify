import { GrantSearch } from '@/components/grants/grant-search'

export default function GrantsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Grants</h1>
        <p className="text-sm text-muted-foreground">
          Search live federal opportunities from Grants.gov. Importing into your
          pipeline arrives with the database layer.
        </p>
      </div>
      <GrantSearch />
    </div>
  )
}
