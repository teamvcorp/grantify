'use client'

import { useEffect, useState } from 'react'

interface Entry {
  id: string
  type: string
  detail: string
  created_at: string
}

const TYPE_LABEL: Record<string, string> = {
  status_change: 'Status',
  phase_change: 'Phase',
  note_added: 'Note',
  doc_uploaded: 'Document',
  form_generated: 'Form',
  narrative_drafted: 'Narrative',
  submitted: 'Submitted',
}

export function ActivityPanel({ grantId, refreshKey }: { grantId: string; refreshKey?: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/grants/${grantId}/activity`)
      if (res.ok) setEntries((await res.json()).activity)
      else setEntries([])
    })()
  }, [grantId, refreshKey])

  if (entries === null) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>
  }

  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-4 text-sm">
          <span>
            <span className="font-medium">{TYPE_LABEL[e.type] ?? e.type}</span> — {e.detail}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {new Date(e.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
        </li>
      ))}
    </ul>
  )
}
