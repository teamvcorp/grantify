'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/catalyst/badge'
import { Select } from '@/components/catalyst/select'
import { Progress } from '@/components/ui/progress'
import { sourceColor, readApiJson } from '@/lib/ui'
import {
  Sparkles,
  Wand2,
  FileText,
  Save,
  Loader2,
  ArrowLeft,
  Printer,
  Mail,
  CheckCircle2,
  AlertTriangle,
  BookOpen,
} from 'lucide-react'
import { BudgetPanel } from '@/components/grants/budget-panel'
import { ActivityPanel } from '@/components/grants/activity-panel'
import { GrantDocumentsPanel } from '@/components/grants/grant-documents-panel'

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
  const [promoting, setPromoting] = useState(false)

  const [narrative, setNarrative] = useState('')
  // Bumped after actions that write activity, to refresh the activity panel.
  const [activityKey, setActivityKey] = useState(0)
  const bumpActivity = () => setActivityKey((k) => k + 1)

  // Grant-scoped documents — used to attach a file to file-type fields.
  const [grantDocs, setGrantDocs] = useState<{ id: string; name: string }[]>([])

  const loadForm = useCallback(async () => {
    const res = await fetch(`/api/grants/${grantId}/form`)
    if (res.ok) {
      const data = await res.json()
      setForm(data.form)
      setNarrative(data.form?.narrative_draft ?? '')
    }
  }, [grantId])

  const loadDocs = useCallback(async () => {
    const res = await fetch(`/api/documents?grant_id=${grantId}`)
    if (res.ok) {
      const data = (await res.json()) as { documents: { id: string; name: string }[] }
      setGrantDocs(data.documents.map((d) => ({ id: d.id, name: d.name })))
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
        await loadDocs()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load.')
      } finally {
        setLoading(false)
      }
    })()
  }, [grantId, loadDocs])

  // Required fields still missing an answer — drives the pre-export compliance check.
  const missingRequired = form
    ? form.fields.filter((f) => f.required && !f.answer.trim())
    : []

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
      const data = await readApiJson<{ form: Form }>(res, 'Generation')
      setForm(data.form)
      bumpActivity()
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
      const data = await readApiJson<{ form: Form }>(res, 'Matching')
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
      bumpActivity()
    }
  }

  function exportPdf() {
    if (!form || !grant) return
    if (
      missingRequired.length > 0 &&
      !confirm(
        `${missingRequired.length} required field(s) are still empty. Export the application anyway?`
      )
    ) {
      return
    }
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const sections = form.sections
      .map((section) => {
        const rows = form.fields
          .filter((f) => f.section === section)
          .map(
            (f) =>
              `<div class="field"><div class="q">${esc(f.question)}</div><div class="a">${
                esc(f.answer) || '<em>—</em>'
              }</div></div>`
          )
          .join('')
        return `<h2>${esc(section)}</h2>${rows}`
      })
      .join('')
    const narr = narrative
      ? `<h2>Narrative</h2><div class="narr">${esc(narrative).replace(/\n/g, '<br/>')}</div>`
      : ''
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
      grant.name
    )}</title><style>
      body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#111}
      h1{font-size:20px} h2{font-size:15px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px}
      .field{margin:10px 0} .q{font-weight:600} .a{white-space:pre-wrap} .narr{white-space:pre-wrap}
      .muted{color:#666}
    </style></head><body>
      <h1>${esc(grant.name)}</h1>
      <p class="muted">${esc(grant.funder)} · ${esc(grant.funder_type)}</p>
      ${sections}${narr}
    </body></html>`
    const w = window.open('', '_blank')
    if (!w) return
    w.document.write(html)
    w.document.close()
    w.focus()
    w.print()
  }

  async function emailGrant() {
    if (
      missingRequired.length > 0 &&
      !confirm(
        `${missingRequired.length} required field(s) are still empty. Send the application anyway?`
      )
    ) {
      return
    }
    const to = prompt('Email the complete grant to (leave blank to send to yourself):')
    if (to === null) return // cancelled
    setError(null)
    try {
      const res = await fetch(`/api/grants/${grantId}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(to.trim() ? { to: to.trim() } : {}),
      })
      const data = await readApiJson<{ sent_to: string }>(res, 'Email')
      alert(`Sent to ${data.sent_to}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Email failed.')
    }
  }

  async function promoteKb() {
    setPromoting(true)
    setError(null)
    try {
      // Persist any unsaved edits first so we learn the latest answers.
      await saveFields()
      const res = await fetch(`/api/grants/${grantId}/promote-kb`, { method: 'POST' })
      const data = await readApiJson<{ added: number; updated: number }>(res, 'Save to KB')
      alert(`Knowledge base updated — ${data.added} new, ${data.updated} refreshed.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the knowledge base.')
    } finally {
      setPromoting(false)
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
        <Button variant="ghost" onClick={exportPdf} disabled={!form}>
          <Printer className="h-4 w-4" />
          Export PDF
        </Button>
        <Button variant="ghost" onClick={emailGrant} disabled={!form}>
          <Mail className="h-4 w-4" />
          Email grant
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

          {/* Pre-export compliance check */}
          {missingRequired.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              All required fields are complete — ready to export.
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-400/10 px-3 py-2 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {missingRequired.length} required field
                {missingRequired.length === 1 ? '' : 's'} still need an answer before export
              </div>
              <ul className="ml-6 list-disc space-y-0.5 text-muted-foreground">
                {missingRequired.map((f) => (
                  <li key={f.id}>
                    <a href={`#${f.id}`} className="hover:text-foreground hover:underline">
                      {f.section} · {f.question}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {form.sections.map((section) => (
            <div key={section} className="space-y-4">
              <h2 className="text-lg font-semibold tracking-tight">{section}</h2>
              {form.fields
                .filter((f) => f.section === section)
                .map((f) => (
                  <div key={f.id} id={f.id} className="scroll-mt-20 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-sm font-medium">
                        {f.question}
                        {f.required && <span className="text-destructive"> *</span>}
                      </label>
                      {SOURCE_LABEL[f.source] && (
                        <Badge color={sourceColor(f.source)}>{SOURCE_LABEL[f.source]}</Badge>
                      )}
                    </div>
                    {f.help_text && (
                      <p className="text-xs text-muted-foreground">{f.help_text}</p>
                    )}
                    {f.type === 'select' ? (
                      <Select value={f.answer} onChange={(e) => setAnswer(f.id, e.target.value)}>
                        <option value="">Select…</option>
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </Select>
                    ) : f.type === 'file' ? (
                      grantDocs.length > 0 ? (
                        <Select
                          value={f.answer}
                          onChange={(e) => setAnswer(f.id, e.target.value)}
                          aria-label="Attach document"
                        >
                          <option value="">Attach a document…</option>
                          {grantDocs.map((d) => (
                            <option key={d.id} value={d.name}>
                              {d.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          Upload a file in the Documents section below, then select it here.
                        </p>
                      )
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

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={saveFields} disabled={savingFields} variant="secondary">
              {savingFields ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save answers
            </Button>
            <Button onClick={promoteKb} disabled={promoting || savingFields} variant="outline">
              {promoting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BookOpen className="h-4 w-4" />
              )}
              Save answers to knowledge base
            </Button>
          </div>

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

      {/* Grant-level panels (independent of the form) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Budget</CardTitle>
        </CardHeader>
        <CardContent>
          <BudgetPanel grantId={grantId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <GrantDocumentsPanel
            grantId={grantId}
            onChange={() => {
              bumpActivity()
              loadDocs()
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityPanel grantId={grantId} refreshKey={activityKey} />
        </CardContent>
      </Card>
    </div>
  )
}
