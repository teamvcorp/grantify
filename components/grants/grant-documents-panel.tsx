'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Upload, Trash2, ExternalLink, Loader2 } from 'lucide-react'
import { DOCUMENT_CATEGORIES } from '@/lib/schemas'

interface Doc {
  id: string
  name: string
  category: string
  blob_url: string
}

export function GrantDocumentsPanel({
  grantId,
  onChange,
}: {
  grantId: string
  onChange?: () => void
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null)
  const [category, setCategory] = useState('other')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function load() {
    const res = await fetch(`/api/documents?grant_id=${grantId}`)
    if (res.ok) setDocs((await res.json()).documents)
    else setDocs([])
  }
  useEffect(() => {
    void (async () => {
      await load()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grantId])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', category)
      fd.append('grant_id', grantId)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Upload failed.')
      }
      await load()
      onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function remove(d: Doc) {
    if (!confirm(`Delete "${d.name}"?`)) return
    const res = await fetch(`/api/documents/${d.id}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-8 rounded-md border bg-transparent px-2 text-sm capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <input ref={fileInput} type="file" hidden onChange={onFile} />
        <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {docs === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No documents attached to this grant.</p>
      ) : (
        <ul className="space-y-1">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
              <a
                href={d.blob_url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 truncate hover:underline"
              >
                {d.name}
                <ExternalLink className="ml-1 inline h-3 w-3 align-baseline" />
              </a>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="capitalize">
                  {d.category.replace(/_/g, ' ')}
                </Badge>
                <Button variant="ghost" size="icon-sm" onClick={() => remove(d)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Delete</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
