'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react'
import { KB_CATEGORIES } from '@/lib/schemas'

interface Entry {
  id: string
  question: string
  answer: string
  category: string
  tags: string[]
  times_used: number
}

type FormState = {
  question: string
  answer: string
  category: string
  tags: string
}

const EMPTY: FormState = { question: '', answer: '', category: 'other', tags: '' }

export function KbManager() {
  const [items, setItems] = useState<Entry[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/kb')
      if (!res.ok) throw new Error('Could not load entries.')
      setItems((await res.json()).entries)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load entries.')
      setItems([])
    }
  }
  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [])

  function openCreate() {
    setEditingId(null)
    setForm(EMPTY)
    setFormError(null)
    setOpen(true)
  }
  function openEdit(e: Entry) {
    setEditingId(e.id)
    setForm({
      question: e.question,
      answer: e.answer,
      category: e.category,
      tags: e.tags.join(', '),
    })
    setFormError(null)
    setOpen(true)
  }

  async function save() {
    setSaving(true)
    setFormError(null)
    const payload = {
      question: form.question.trim(),
      answer: form.answer.trim(),
      category: form.category,
      tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
    }
    try {
      const res = await fetch(editingId ? `/api/kb/${editingId}` : '/api/kb', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Save failed.')
      setOpen(false)
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  async function remove(e: Entry) {
    if (!confirm('Delete this entry?')) return
    const res = await fetch(`/api/kb/${e.id}`, { method: 'DELETE' })
    if (res.ok) load()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-sm text-muted-foreground">
            Reusable answers about your organization. The AI form layer draws on these to
            auto-fill grant applications.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New entry
        </Button>
      </div>

      {listError && <p className="text-sm text-destructive">{listError}</p>}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No entries yet. Add your mission, outcomes, financials, and other reusable answers.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((e) => (
            <Card key={e.id}>
              <CardContent className="space-y-1 py-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">{e.question}</p>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(e)}>
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="sr-only">Edit</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(e)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">{e.answer}</p>
                <div className="flex flex-wrap items-center gap-1 pt-1">
                  <Badge variant="secondary" className="capitalize">
                    {e.category}
                  </Badge>
                  {e.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                  {e.times_used > 0 && (
                    <span className="text-xs text-muted-foreground">
                      used {e.times_used}×
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit entry' : 'New entry'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kb-q">Question</Label>
              <Input
                id="kb-q"
                value={form.question}
                onChange={(e) => setForm({ ...form, question: e.target.value })}
                placeholder="What is your organization's mission?"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kb-a">Answer</Label>
              <Textarea
                id="kb-a"
                value={form.answer}
                onChange={(e) => setForm({ ...form, answer: e.target.value })}
                rows={4}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="kb-cat">Category</Label>
                <select
                  id="kb-cat"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {KB_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="kb-tags">Tags (comma-separated)</Label>
                <Input
                  id="kb-tags"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="mission, overview"
                />
              </div>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !form.question.trim() || !form.answer.trim()}
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
