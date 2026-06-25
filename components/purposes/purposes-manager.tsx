'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/catalyst/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react'
import { FUNDER_TYPES } from '@/lib/schemas'
import { cn } from '@/lib/utils'

interface Purpose {
  id: string
  name: string
  description: string
  focus_areas: string[]
  geography: string
  target_amount: number
  grant_types: string[]
}

type FormState = {
  name: string
  description: string
  focus_areas: string // comma-separated in the form
  geography: string
  target_amount: string // string in the form, parsed on save
  grant_types: string[]
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  focus_areas: '',
  geography: 'national',
  target_amount: '0',
  grant_types: [],
}

export function PurposesManager() {
  const [items, setItems] = useState<Purpose[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)

  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function load() {
    try {
      const res = await fetch('/api/purposes')
      if (!res.ok) throw new Error('Could not load purposes.')
      const data = await res.json()
      setItems(data.purposes)
      setListError(null)
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Could not load purposes.')
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
    setForm(EMPTY_FORM)
    setFormError(null)
    setOpen(true)
  }

  function openEdit(p: Purpose) {
    setEditingId(p.id)
    setForm({
      name: p.name,
      description: p.description,
      focus_areas: p.focus_areas.join(', '),
      geography: p.geography,
      target_amount: String(p.target_amount),
      grant_types: p.grant_types,
    })
    setFormError(null)
    setOpen(true)
  }

  function toggleType(t: string) {
    setForm((f) => ({
      ...f,
      grant_types: f.grant_types.includes(t)
        ? f.grant_types.filter((x) => x !== t)
        : [...f.grant_types, t],
    }))
  }

  async function save() {
    setSaving(true)
    setFormError(null)
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      focus_areas: form.focus_areas
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      geography: form.geography.trim() || 'national',
      target_amount: Number(form.target_amount) || 0,
      grant_types: form.grant_types,
    }
    try {
      const res = await fetch(
        editingId ? `/api/purposes/${editingId}` : '/api/purposes',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      )
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

  async function remove(p: Purpose) {
    if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/purposes/${p.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Delete failed.')
      await load()
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Delete failed.')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Purposes</h1>
          <p className="text-sm text-muted-foreground">
            Separate application contexts, each with its own grant pipeline.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          New purpose
        </Button>
      </div>

      {listError && <p className="text-sm text-destructive">{listError}</p>}

      {items === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No purposes yet. Create one to start a grant pipeline.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((p) => (
            <Card key={p.id}>
              <CardContent className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium">{p.name}</h3>
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(p)}>
                      <Pencil className="h-3.5 w-3.5" />
                      <span className="sr-only">Edit</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => remove(p)}>
                      <Trash2 className="h-3.5 w-3.5" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </div>
                {p.description && (
                  <p className="text-sm text-muted-foreground">{p.description}</p>
                )}
                <div className="flex flex-wrap gap-1">
                  {p.focus_areas.map((f) => (
                    <Badge key={f} color="zinc">
                      {f}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.geography} · target ${p.target_amount.toLocaleString()}
                  {p.grant_types.length > 0 && ` · ${p.grant_types.join(', ')}`}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit purpose' : 'New purpose'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="p-name">Name</Label>
              <Input
                id="p-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Youth STEM Education"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-desc">Description</Label>
              <Textarea
                id="p-desc"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="What this funding pipeline is for."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="p-focus">Focus areas (comma-separated)</Label>
              <Input
                id="p-focus"
                value={form.focus_areas}
                onChange={(e) => setForm({ ...form, focus_areas: e.target.value })}
                placeholder="education, youth, STEM"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="p-geo">Geography</Label>
                <Input
                  id="p-geo"
                  value={form.geography}
                  onChange={(e) => setForm({ ...form, geography: e.target.value })}
                  placeholder="national · state:TX · city:Austin"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="p-amount">Target amount ($)</Label>
                <Input
                  id="p-amount"
                  type="number"
                  min={0}
                  value={form.target_amount}
                  onChange={(e) => setForm({ ...form, target_amount: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Funder types</Label>
              <div className="flex flex-wrap gap-2">
                {FUNDER_TYPES.map((t) => {
                  const active = form.grant_types.includes(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleType(t)}
                      className={cn(
                        'rounded-md border px-3 py-1 text-sm capitalize transition-colors',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent'
                      )}
                    >
                      {t}
                    </button>
                  )
                })}
              </div>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !form.name.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Save changes' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
