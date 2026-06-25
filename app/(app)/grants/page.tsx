'use client'

import { useState } from 'react'
import { GrantPipeline } from '@/components/grants/grant-pipeline'
import { GrantSearch } from '@/components/grants/grant-search'

export default function GrantsPage() {
  // Bump to re-fetch the pipeline after an import.
  const [version, setVersion] = useState(0)

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Grants</h1>
        <p className="text-sm text-muted-foreground">
          Your pipeline, plus federal (Grants.gov) and AI discovery to find and import new
          opportunities.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Pipeline</h2>
        <GrantPipeline version={version} />
      </section>

      <section className="space-y-4 border-t pt-8">
        <h2 className="text-lg font-semibold tracking-tight">Find &amp; import</h2>
        <GrantSearch onImported={() => setVersion((v) => v + 1)} />
      </section>
    </div>
  )
}
