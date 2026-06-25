'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Trash2, Save, Loader2 } from 'lucide-react'

interface LineItem {
  id: string
  category: string
  description: string
  amount: number
}

// Browser-safe id (avoids needing a uuid dep on the client).
function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

export function BudgetPanel({ grantId }: { grantId: string }) {
  const [items, setItems] = useState<LineItem[]>([])
  const [notes, setNotes] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/grants/${grantId}/budget`)
      if (res.ok) {
        const data = await res.json()
        setItems(data.budget.items ?? [])
        setNotes(data.budget.notes ?? '')
      }
      setLoaded(true)
    })()
  }, [grantId])

  const total = items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0)

  function update(id: string, patch: Partial<LineItem>) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }

  async function save() {
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/grants/${grantId}/budget`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items.map((i) => ({ ...i, amount: Number(i.amount) || 0 })),
          notes,
        }),
      })
      if (!res.ok) throw new Error('Save failed.')
      setMsg('Saved.')
    } catch {
      setMsg('Save failed.')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading budget…</p>

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {items.map((i) => (
          <div key={i.id} className="flex items-center gap-2">
            <Input
              value={i.category}
              onChange={(e) => update(i.id, { category: e.target.value })}
              placeholder="Category"
              className="w-40"
            />
            <Input
              value={i.description}
              onChange={(e) => update(i.id, { description: e.target.value })}
              placeholder="Description"
              className="flex-1"
            />
            <Input
              type="number"
              min={0}
              value={i.amount}
              onChange={(e) => update(i.id, { amount: Number(e.target.value) })}
              placeholder="0"
              className="w-32"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== i.id))}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="sr-only">Remove line</span>
            </Button>
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          setItems((xs) => [...xs, { id: newId(), category: '', description: '', amount: 0 }])
        }
      >
        <Plus className="h-3.5 w-3.5" />
        Add line item
      </Button>

      <div className="flex items-center justify-between border-t pt-2 text-sm">
        <span className="font-medium">Total</span>
        <span className="font-semibold">${total.toLocaleString()}</span>
      </div>

      <Textarea
        rows={3}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Budget notes / justification…"
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving} variant="secondary" size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save budget
        </Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>
    </div>
  )
}
