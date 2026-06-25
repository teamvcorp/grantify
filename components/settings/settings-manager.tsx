'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Plus, Trash2, Loader2, Save, KeyRound } from 'lucide-react'
import { USER_ROLES } from '@/lib/schemas'

interface Member {
  id: string
  email: string
  name: string
  role: string
  last_login: string | null
}

export function SettingsManager() {
  const [role, setRole] = useState<string>('member')
  const [meId, setMeId] = useState<string>('')
  const isAdmin = role === 'admin'

  // Org profile
  const [orgName, setOrgName] = useState('')
  const [ein, setEin] = useState('')
  const [plan, setPlan] = useState('free')
  const [billingConfigured, setBillingConfigured] = useState(false)
  const [billingBusy, setBillingBusy] = useState(false)
  const [billingMsg, setBillingMsg] = useState<string | null>(null)
  const [savingOrg, setSavingOrg] = useState(false)
  const [orgMsg, setOrgMsg] = useState<string | null>(null)

  // Team
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Add-member dialog
  const [open, setOpen] = useState(false)
  const [mEmail, setMEmail] = useState('')
  const [mName, setMName] = useState('')
  const [mRole, setMRole] = useState('member')
  const [mPassword, setMPassword] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  async function loadTeam() {
    const res = await fetch('/api/team')
    if (res.ok) {
      const data = await res.json()
      setMembers(data.members)
      setMeId(data.me)
      setRole(data.role)
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const [o, t] = await Promise.all([fetch('/api/org'), fetch('/api/team')])
        if (o.ok) {
          const data = await o.json()
          setOrgName(data.org.name)
          setEin(data.org.ein)
          setPlan(data.org.plan)
          setRole(data.role)
          setBillingConfigured(data.billing_configured)
        }
        if (t.ok) {
          const data = await t.json()
          setMembers(data.members)
          setMeId(data.me)
          setRole(data.role)
        }
      } catch {
        setError('Failed to load settings.')
      }
    })()
  }, [])

  async function saveOrg() {
    setSavingOrg(true)
    setOrgMsg(null)
    try {
      const res = await fetch('/api/org', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName.trim(), ein: ein.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Save failed.')
      setOrgMsg('Saved.')
    } catch (err) {
      setOrgMsg(err instanceof Error ? err.message : 'Save failed.')
    } finally {
      setSavingOrg(false)
    }
  }

  async function addMember() {
    setAdding(true)
    setAddError(null)
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: mEmail.trim(),
          name: mName.trim(),
          role: mRole,
          password: mPassword,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not add member.')
      setOpen(false)
      setMEmail('')
      setMName('')
      setMRole('member')
      setMPassword('')
      await loadTeam()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add member.')
    } finally {
      setAdding(false)
    }
  }

  async function upgrade(target: 'pro' | 'team') {
    setBillingBusy(true)
    setBillingMsg(null)
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: target }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Checkout failed.')
      if (data.url) window.location.href = data.url
    } catch (err) {
      setBillingMsg(err instanceof Error ? err.message : 'Checkout failed.')
    } finally {
      setBillingBusy(false)
    }
  }

  async function openPortal() {
    setBillingBusy(true)
    setBillingMsg(null)
    try {
      const res = await fetch('/api/billing/portal', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not open billing.')
      if (data.url) window.location.href = data.url
    } catch (err) {
      setBillingMsg(err instanceof Error ? err.message : 'Could not open billing.')
    } finally {
      setBillingBusy(false)
    }
  }

  async function changeRole(id: string, newRole: string) {
    setMembers((ms) => ms && ms.map((m) => (m.id === id ? { ...m, role: newRole } : m)))
    const res = await fetch(`/api/team/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    })
    if (!res.ok) loadTeam()
  }

  async function resetPassword(m: Member) {
    const pw = prompt(`Set a new temporary password for ${m.name} (min 8 chars):`)
    if (!pw) return
    if (pw.length < 8) {
      alert('Password must be at least 8 characters.')
      return
    }
    const res = await fetch(`/api/team/${m.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    if (res.ok) alert('Password reset. Share it with the member.')
    else {
      const d = await res.json().catch(() => ({}))
      alert(d.error || 'Reset failed.')
    }
  }

  async function removeMember(m: Member) {
    if (!confirm(`Remove ${m.name} (${m.email})?`)) return
    setMembers((ms) => ms && ms.filter((x) => x.id !== m.id))
    const res = await fetch(`/api/team/${m.id}`, { method: 'DELETE' })
    if (!res.ok) loadTeam()
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Organization profile, team members, and plan.
          {!isAdmin && ' Some actions require an admin role.'}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Organization */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org-name">Name</Label>
              <Input
                id="org-name"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                disabled={!isAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org-ein">EIN</Label>
              <Input
                id="org-ein"
                value={ein}
                onChange={(e) => setEin(e.target.value)}
                placeholder="XX-XXXXXXX"
                disabled={!isAdmin}
              />
            </div>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-3">
              <Button onClick={saveOrg} disabled={savingOrg || !orgName.trim()} variant="secondary">
                {savingOrg ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
              {orgMsg && <span className="text-sm text-muted-foreground">{orgMsg}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Team */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Team members</CardTitle>
          {isAdmin && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add member
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {members === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ul className="divide-y">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {m.name}{' '}
                      {m.id === meId && <span className="text-xs text-muted-foreground">(you)</span>}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">{m.email}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isAdmin && m.id !== meId ? (
                      <select
                        value={m.role}
                        onChange={(e) => changeRole(m.id, e.target.value)}
                        className="h-7 rounded-md border bg-transparent px-2 text-xs capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {USER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="outline" className="capitalize">
                        {m.role}
                      </Badge>
                    )}
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => resetPassword(m)}
                        title="Reset password"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        <span className="sr-only">Reset password</span>
                      </Button>
                    )}
                    {isAdmin && m.id !== meId && (
                      <Button variant="ghost" size="icon-sm" onClick={() => removeMember(m)}>
                        <Trash2 className="h-3.5 w-3.5" />
                        <span className="sr-only">Remove</span>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Plan */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan &amp; billing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm">Current plan:</span>
            <Badge variant="secondary" className="capitalize">
              {plan}
            </Badge>
          </div>

          {!isAdmin ? (
            <p className="text-sm text-muted-foreground">Ask an admin to change the plan.</p>
          ) : !billingConfigured ? (
            <p className="text-sm text-muted-foreground">
              Billing isn&apos;t configured yet. Add <code>STRIPE_SECRET_KEY</code>,{' '}
              <code>STRIPE_WEBHOOK_SECRET</code>, and the <code>STRIPE_PRICE_*</code> env vars to
              enable upgrades.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {plan !== 'pro' && (
                <Button size="sm" onClick={() => upgrade('pro')} disabled={billingBusy}>
                  {billingBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Upgrade to Pro
                </Button>
              )}
              {plan !== 'team' && (
                <Button size="sm" onClick={() => upgrade('team')} disabled={billingBusy}>
                  {billingBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  Upgrade to Team
                </Button>
              )}
              {plan !== 'free' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={openPortal}
                  disabled={billingBusy}
                >
                  Manage billing
                </Button>
              )}
            </div>
          )}
          {billingMsg && <p className="text-sm text-destructive">{billingMsg}</p>}
        </CardContent>
      </Card>

      {/* Add-member dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="m-name">Name</Label>
              <Input id="m-name" value={mName} onChange={(e) => setMName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="m-email">Email</Label>
              <Input
                id="m-email"
                type="email"
                value={mEmail}
                onChange={(e) => setMEmail(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="m-role">Role</Label>
                <select
                  id="m-role"
                  value={mRole}
                  onChange={(e) => setMRole(e.target.value)}
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm capitalize focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {USER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="m-pass">Temp password</Label>
                <Input
                  id="m-pass"
                  type="text"
                  value={mPassword}
                  onChange={(e) => setMPassword(e.target.value)}
                  placeholder="≥ 8 characters"
                />
              </div>
            </div>
            {addError && <p className="text-sm text-destructive">{addError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={adding}>
              Cancel
            </Button>
            <Button
              onClick={addMember}
              disabled={adding || !mEmail.trim() || !mName.trim() || mPassword.length < 8}
            >
              {adding && <Loader2 className="h-4 w-4 animate-spin" />}
              Add member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
