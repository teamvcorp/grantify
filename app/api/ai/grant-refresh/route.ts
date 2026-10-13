import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  requestBaseFor,
  WEB_FETCH_TOOL,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { grants } from '@/lib/collections'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { isFetchableUrl } from '@/lib/discovery'
import { logActivity } from '@/lib/activity'

/**
 * POST /api/ai/grant-refresh — re-read a grant's own page ("spec sheet") and
 * pull its current details back into the record.
 *
 * WHY: most foundation grants are ANNUAL. Discovery now keeps a program whose
 * cycle is closed and labels it "recurring" rather than deleting it, which
 * means a tracked grant can sit in the pipeline for months with last year's
 * dates on it. This is the button that brings it up to date the moment the new
 * cycle opens, without the user re-typing anything.
 *
 * Only fills gaps and refreshes funder-published facts (deadline, amounts,
 * eligibility/requirements). It NEVER touches the team's own work — status,
 * phase, notes, narrative and form answers are untouched.
 *
 * SECURITY: the grant is loaded org-scoped, and its URL is re-checked with
 * `isFetchableUrl` before the server fetches anything, because a stored URL is
 * still user-supplied input (SSRF boundary).
 */

export const runtime = 'nodejs'
export const maxDuration = 120

const BodySchema = z.object({ grant_id: z.string().min(1) })

const Extracted = z.object({
  /** false when the page is gone or is not this grant any more. */
  found: z.boolean(),
  reason: z.string().trim().default(''),
  deadline_kind: z.enum(['fixed', 'rolling', 'annual', 'unknown']).catch('unknown'),
  deadline: z.string().trim().nullable().catch(null),
  next_cycle: z.string().trim().nullable().catch(null),
  amount_min: z.number().nullable().catch(null),
  amount_max: z.number().nullable().catch(null),
  eligibility: z.string().trim().default('').catch(''),
  /** What the funder says they fund + how to apply, for the form/narrative. */
  requirements: z.string().trim().default('').catch(''),
  summary: z.string().trim().default('').catch(''),
})

function buildPrompt(grant: { name: string; funder: string; url: string }): string {
  return `Open this grant program's page and report its CURRENT details.

GRANT ON FILE
- Name: ${grant.name}
- Funder: ${grant.funder}
- URL: ${grant.url}

METHOD: use web_fetch to open that URL and read it. If it redirects or the program has moved, follow at most one obvious link to the live program page.

Report ONLY what the page says now. This record may be months old, so the dates on file are probably stale — that is exactly what we are here to fix. Never carry over or invent a date; if the page does not state something, use null or "".

Return ONLY a JSON object (no prose, no fences):
{
  "found": boolean,            // false only if the page is gone or is no longer this program
  "reason": string,            // when found is false, what you saw instead
  "deadline_kind": "fixed" | "rolling" | "annual" | "unknown",
  "deadline": string | null,   // ISO "YYYY-MM-DD" when a specific date is posted (even if past)
  "next_cycle": string | null, // e.g. "applications reopen December 2026", if stated
  "amount_min": number | null,
  "amount_max": number | null,
  "eligibility": string,       // who may apply, from the page
  "requirements": string,      // what they fund and how to apply, from the page
  "summary": string            // 1-2 sentences on what changed or what stands out
}`
}

export async function POST(req: Request) {
  try {
    const session = await auth()
    if (!session?.user?.org_id) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }
    const parsed = BodySchema.safeParse(body)
    if (!parsed.success || !ObjectId.isValid(parsed.data.grant_id)) {
      return NextResponse.json({ error: 'A valid grant_id is required.' }, { status: 400 })
    }

    const orgId = new ObjectId(session.user.org_id)
    const col = await grants()
    const grant = await col.findOne({
      _id: new ObjectId(parsed.data.grant_id),
      org_id: orgId, // ORG-SCOPED — never by id alone
    })
    if (!grant) {
      return NextResponse.json({ error: 'Grant not found.' }, { status: 404 })
    }
    if (!grant.url) {
      return NextResponse.json(
        { error: 'This grant has no source URL to read. Add one first.' },
        { status: 400 }
      )
    }
    // A stored URL is still user-supplied input — re-check before fetching.
    if (!(await isFetchableUrl(grant.url))) {
      return NextResponse.json(
        { error: 'That grant URL could not be reached.' },
        { status: 400 }
      )
    }

    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const client = getAnthropic()
    const base = requestBaseFor('grant-refresh')
    const messages: Parameters<typeof client.messages.create>[0]['messages'] = [
      {
        role: 'user',
        content: buildPrompt({ name: grant.name, funder: grant.funder, url: grant.url }),
      },
    ]
    const createParams = {
      ...base,
      max_tokens: 3000,
      tools: [{ ...WEB_FETCH_TOOL, max_uses: 2 }],
      messages,
    }

    let response = await client.messages.create(createParams)
    await chargeUsage(orgId, base.model, response.usage)
    // Resume across server-tool pauses, carrying the container id (see NOTES.md).
    let guard = 0
    while (response.stop_reason === 'pause_turn' && guard++ < 4) {
      const containerId = response.container?.id ?? null
      messages.push({ role: 'assistant', content: response.content })
      response = await client.messages.create({
        ...createParams,
        ...(containerId ? { container: containerId } : {}),
      })
      await chargeUsage(orgId, base.model, response.usage)
    }

    const data = Extracted.safeParse(parseJsonFromText(textFromMessage(response)))
    if (!data.success) {
      return NextResponse.json(
        { error: 'Could not read that page. Try again, or open it yourself.' },
        { status: 502 }
      )
    }
    if (!data.data.found) {
      return NextResponse.json({
        updated: false,
        reason: data.data.reason || 'That page no longer shows this grant program.',
      })
    }
    const x = data.data

    // Build the update. Only funder-published facts — never the team's own work
    // (status, phase, notes, narrative and form answers are deliberately absent).
    const set: Record<string, unknown> = { updated_at: new Date() }
    const changed: string[] = []

    if (x.deadline_kind === 'fixed' && x.deadline) {
      const d = new Date(x.deadline)
      if (!Number.isNaN(d.getTime())) {
        const before = grant.deadline_full ? new Date(grant.deadline_full).toISOString().slice(0, 10) : null
        if (before !== x.deadline) {
          set.deadline_full = d
          changed.push(`deadline ${before ?? 'none'} → ${x.deadline}`)
        }
      }
    } else if (x.deadline_kind === 'rolling' && grant.deadline_full) {
      // The page now says rolling, so a stale date on file is wrong.
      set.deadline_full = null
      changed.push('deadline cleared (now rolling)')
    }

    if (x.amount_min != null && x.amount_min !== grant.amount_min) {
      set.amount_min = x.amount_min
      changed.push('minimum amount')
    }
    if (x.amount_max != null && x.amount_max !== grant.amount_max) {
      set.amount_max = x.amount_max
      changed.push('maximum amount')
    }

    // Requirements feed generate-form and draft-narrative, so refreshing them
    // is the most valuable part of this for an annual grant.
    const requirements = [x.requirements, x.eligibility].filter(Boolean).join('\n\n').trim()
    if (requirements && requirements !== (grant.requirements_raw ?? '').trim()) {
      set.requirements_raw = requirements
      changed.push('what they fund / eligibility')
    }

    if (changed.length > 0) {
      await col.updateOne({ _id: grant._id, org_id: orgId }, { $set: set })
      await logActivity({
        grant_id: grant._id!,
        org_id: orgId,
        user_id: new ObjectId(session.user.id),
        type: 'note_added',
        detail: `Refreshed from source: ${changed.join(', ')}`,
      }).catch(() => {})
    }

    return NextResponse.json({
      updated: changed.length > 0,
      changed,
      deadline_kind: x.deadline_kind,
      next_cycle: x.next_cycle,
      summary: x.summary,
    })
  } catch (err) {
    console.error('[ai/grant-refresh] failed:', err)
    const raw = err instanceof Error ? err.message : ''
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody ? 'Could not refresh this grant. Please try again.' : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
