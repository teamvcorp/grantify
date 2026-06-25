'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import {
  Sparkles,
  Wand2,
  FileText,
  Save,
  Loader2,
  ArrowLeft,
} from 'lucide-react'

interface Grant {
  id: string
  name: string
  funder: string
  funder_type: string
}

interface Field {
  id: string
  question: string
  type: string
  options: string[]
  answer: string
  source: string
  required: boolean
  section: string
  help_text: string
}

interface Form {
  id?: string
  fields: Field[]
  sections: string[]
  completed_pct: number
  narrative_draft: string
}

const SOURCE_LABEL: Record<string, string> = { ai: 'AI', kb: 'KB', team: 'edited', empty: '' }

export function GrantWorkspace({ grantId }: { grantId: string }) {
  const [grant, setGrant] = useState<Grant | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [generating, setGenerating] = useState(false)
  const [matching, setMatching] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [savingFields, setSavingFields] = useState(false)
  const [savingNarrative, setSavingNarrative] = useState(false)

  const [narrative, setNarrative] = useState('')

  const loadForm = useCallback(async () => {
    const res = await fetch(`/api/grants/${grantId}/form`)
    if (res.ok) {
      const data = await res.json()
      setForm(data.form)
      setNarrative(data.form?.narrative_draft ?? '')
    }
  }, [grantId])

  useEffect(() => {
    ;(async () => {
      try {
        const [g, f] = await Promise.all([
          fetch(`/api/grants/${grantId}`),
          fetch(`/api/grants/${grantId}/form`),
        ])
        if (!g.ok) throw new Error('Grant not found.')
        setGrant((await g.json()).grant)
        if (f.ok) {
          const data = await f.json()
          setForm(data.form)
          setNarrative(data.form?.narrative_draft ?? '')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        setLoading(false)
      }
    })()
  }, [grantId])

  function setAnswer(id: string, answer: string) {
    setForm((f) =>
      f ? { ...f, fields: f.fields.map((x) => (x.id === id ? { ...x, answer } : x)) } : f
    )
  }

  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/ai/generate-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_id: grantId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Generation failed.')
      setForm(data.form)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed.')
    } finally {
      setGenerating(false)
    }
  }

  async function matchKb() {
    setMatching(true)
    setError(null)
    try {
      const res = await fetch('/api/ai/match-kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_id: grantId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Matching failed.')
      setForm(data.form)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Matching failed.')
    } finally {
      setMatching(false)
    }
  }

  async function saveFields() {
    if (!form) return
    setSavingFields(true)
    try {
      await fetch(`/api/grants/${grantId}/form`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: form.fields.map((f) => ({ id: f.id, answer: f.answer })),
        }),
      })
      await loadForm()
    } finally {
      setSavingFields(false)
    }
  }

  async function draft() {
    setDrafting(true)
    setError(null)
    setNarrative('')
    try {
      const res = await fetch('/api/ai/draft-narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_id: grantId }),
      })
      if (!res.ok || !res.body) {
        throw new Error((await res.text()) || 'Draft failed.')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        setNarrative((prev) => prev + decoder.decode(value, { stream: true }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Draft failed.')
    } finally {
      setDrafting(false)
    }
  }

  async function saveNarrative() {
    setSavingNarrative(true)
    try {
      await fetch(`/api/grants/${grantId}/form`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narrative_draft: narrative }),
      })
    } finally {
      setSavingNarrative(false)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (error && !grant) return <p className="text-sm text-destructive">{error}</p>

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link
          href="/grants"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Grants
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{grant?.name}</h1>
        <p className="text-sm text-muted-foreground">
          {grant?.funder} · <span className="capitalize">{grant?.funder_type}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={generating}>
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {form ? 'Regenerate form' : 'Generate form'}
        </Button>
        <Button variant="outline" onClick={matchKb} disabled={!form || matching}>
          {matching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          Match knowledge base
        </Button>
        <Button variant="outline" onClick={draft} disabled={!form || drafting}>
          {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          Draft narrative
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!form ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No application form yet. Click <span className="font-medium">Generate form</span> to
            have AI build the field list from this grant&apos;s requirements.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Completion</span>
              <span className="text-muted-foreground">{form.completed_pct}%</span>
            </div>
            <Progress value={form.completed_pct} />
          </div>

          {form.sections.map((section) => (
            <div key={section} className="space-y-4">
              <h2 className="text-lg font-semibold tracking-tight">{section}</h2>
              {form.fields
                .filter((f) => f.section === section)
                .map((f) => (
                  <div key={f.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-sm font-medium">
                        {f.question}
                        {f.required && <span className="text-destructive"> *</span>}
                      </label>
                      {SOURCE_LABEL[f.source] && (
                        <Badge variant={f.source === 'kb' ? 'secondary' : 'outline'}>
                          {SOURCE_LABEL[f.source]}
                        </Badge>
                      )}
                    </div>
                    {f.help_text && (
                      <p className="text-xs text-muted-foreground">{f.help_text}</p>
                    )}
                    {f.type === 'select' ? (
                      <select
                        value={f.answer}
                        onChange={(e) => setAnswer(f.id, e.target.value)}
                        className="h-9 w-full rounded-md border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <option value="">Select…</option>
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'file' ? (
                      <p className="text-xs text-muted-foreground">
                        Attach in the Documents vault.
                      </p>
                    ) : f.type === 'text' || f.type === 'date' || f.type === 'number' ? (
                      <Input
                        type={f.type === 'text' ? 'text' : f.type}
                        value={f.answer}
                        onChange={(e) => setAnswer(f.id, e.target.value)}
                      />
                    ) : (
                      <Textarea
                        rows={4}
                        value={f.answer}
                        onChange={(e) => setAnswer(f.id, e.target.value)}
                      />
                    )}
                  </div>
                ))}
            </div>
          ))}

          <Button onClick={saveFields} disabled={savingFields} variant="secondary">
            {savingFields ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save answers
          </Button>

          {/* Narrative */}
          <div className="space-y-3 border-t pt-6">
            <h2 className="text-lg font-semibold tracking-tight">Narrative draft</h2>
            <Textarea
              rows={14}
              value={narrative}
              onChange={(e) => setNarrative(e.target.value)}
              placeholder="Click 'Draft narrative' to generate from your answers, or write here."
            />
            <Button onClick={saveNarrative} disabled={savingNarrative} variant="secondary">
              {savingNarrative ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save narrative
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
