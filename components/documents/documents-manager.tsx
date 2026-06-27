'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/catalyst/badge'
import { Select } from '@/components/catalyst/select'
import { Upload, Trash2, ExternalLink, Loader2 } from 'lucide-react'
import { DOCUMENT_CATEGORIES } from '@/lib/schemas'

interface Doc {
  id: string
  name: string
  category: string
  blob_url: string
  file_type: string
  uploaded_at: string
}

export function DocumentsManager() {
  const [items, setItems] = useState<Doc[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState('other')
  const [uploading, setUploading] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function load() {
    try {
      const res = await fetch('/api/documents')
      if (!res.ok) throw new Error('Could not load documents.')
      setItems((await res.json()).documents)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load documents.')
      setItems([])
    }
  }
  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('category', category)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Upload failed.')
      await load()
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Org-wide file vault (IRS letter, financials, board list, support letters), stored in
          Vercel Blob.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Document category"
          className="capitalize sm:w-56"
        >
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
        <input ref={fileInput} type="file" hidden onChange={onFile} />
        <Button onClick={() => fileInput.current?.click()} disabled={uploading}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No documents yet. Upload your IRS determination letter, financials, and board list.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((d) => (
            <Card key={d.id}>
              <CardContent className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0 space-y-1">
                  <a
                    href={`/api/documents/${d.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                  >
                    {d.name}
                    <ExternalLink className="ml-1 inline h-3 w-3 align-baseline" />
                  </a>
                  <div>
                    <Badge color="zinc" className="capitalize">
                      {d.category.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                </div>
                <Button variant="ghost" size="icon-sm" onClick={() => remove(d)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Delete</span>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
