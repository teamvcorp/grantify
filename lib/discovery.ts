import dns from 'node:dns/promises'
import net from 'node:net'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { grants, orgs } from './collections'
import { getActiveInstructions, getCompanyContext } from './org-ai'

/**
 * Shared pieces of AI grant discovery, used by BOTH phases:
 *   POST /api/ai/discover         — phase 1, search only, returns candidates
 *   POST /api/ai/discover/verify  — phase 2, verifies ONE candidate
 *
 * WHY TWO PHASES: discovery used to be one long request that searched, fetched
 * and verified every candidate before returning anything. On Vercel that request
 * exceeded the function limit and was killed at the platform level — a raw HTTP
 * 504 with a non-JSON body, and EVERY result lost. Splitting it means each
 * request is short and each verified grant reaches the user as soon as it's
 * ready, so a timeout costs you one candidate instead of the whole run.
 * (`maxDuration = 300` only applies on Vercel Pro; Hobby clamps to 60s.)
 */

/** Cap on candidates per run — bounds both cost and total wall-clock. */
export const MAX_CANDIDATES = 6

/** A lead from phase 1: enough to go and verify, not yet trusted. */
export const Candidate = z.object({
  name: z.string().trim().min(1).max(300),
  funder: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000),
})
export type Candidate = z.infer<typeof Candidate>

/** The QUALIFIED shape phase 2 must produce for a candidate to be shown. */
/**
 * Confidence tier for a discovered grant. Replaces the old keep-or-drop gate.
 *
 * WHY THIS EXISTS: the previous contract demanded a CURRENTLY OPEN program with
 * a confirmed future deadline and non-empty eligibility, and silently deleted
 * everything else. Most foundation grants are ANNUAL, so their page almost
 * always shows a closed cycle ("applications closed Feb 15, reopen in
 * December") — a real, fundable, recurring program that the old rule threw
 * away. That is why discovery returned nothing nearly every run.
 *
 * Now nothing real is discarded; it is LABELLED, and the user decides.
 */
export const DISCOVERY_STATUSES = ['open', 'recurring', 'unconfirmed'] as const
export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number]

export const DiscoveredGrant = z.object({
  name: z.string().trim().min(1),
  funder: z.string().trim().min(1),
  funder_type: z.enum(['federal', 'foundation', 'state', 'corporate', 'other']),
  amount_min: z.number().nullable(),
  amount_max: z.number().nullable(),
  /**
   * 'annual' = a recurring program whose current cycle is closed.
   * 'unknown' = the page did not say. Both are KEPT now, labelled.
   */
  deadline_kind: z.enum(['fixed', 'rolling', 'annual', 'unknown']).catch('unknown'),
  deadline: z.string().nullable().catch(null), // ISO "YYYY-MM-DD" when kind==='fixed'
  /** Free text from the page about when the next cycle opens, if it said. */
  next_cycle: z.string().trim().nullable().default(null).catch(null),
  url: z.string().url(),
  source_url: z.string().url(), // the page the model actually opened
  // Loosened from min(1): a missing eligibility statement now downgrades the
  // tier instead of deleting an otherwise real opportunity.
  eligibility: z.string().trim().default('').catch(''),
  focus_areas: z.array(z.string()).default([]).catch([]),
  summary: z.string().default('').catch(''),
})
export type DiscoveredGrant = z.infer<typeof DiscoveredGrant>

/**
 * A funder we know runs a grant program, without a specific open opportunity.
 *
 * Grant programs are often announced on a page with no machine-readable
 * deadline, or only open for a few weeks a year. A directory of WHO to check
 * is genuinely useful even when nothing is open today — the user can work the
 * list manually and revisit annually.
 */
export const FunderLead = z.object({
  funder: z.string().trim().min(1),
  url: z.string().url(),
  /** What this funder supports, in their words where possible. */
  focus: z.string().trim().default(''),
  /** e.g. "opens each December", "rolling", "unknown". */
  cycle: z.string().trim().default(''),
  funder_type: z
    .enum(['federal', 'foundation', 'state', 'corporate', 'other'])
    .catch('other'),
})
export type FunderLead = z.infer<typeof FunderLead>

/** Normalize a URL for dedup: drop protocol + trailing slashes, lowercase. */
export function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** Name+funder dedup key. */
export function nameKey(funder: string, name: string): string {
  return `${funder}|${name}`.trim().toLowerCase()
}

/** True for addresses we must never let the server fetch (SSRF protection). */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 || // "this" network
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local (cloud metadata lives here)
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      a >= 224 // multicast / reserved
    )
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (v6 === '::' || v6 === '::1') return true
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true // unique-local
  if (v6.startsWith('fe80')) return true // link-local
  // IPv4-MAPPED addresses — re-check the embedded v4 address. Two spellings
  // matter: the dotted form (::ffff:127.0.0.1) and the HEX form Node's URL
  // parser normalizes it to (::ffff:7f00:1). Missing the hex form was a real
  // bypass — http://[::ffff:127.0.0.1]/ reached loopback.
  const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return isPrivateAddress(dotted[1])
  const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    const v4 = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.')
    return isPrivateAddress(v4)
  }
  return false
}

/**
 * Reject a URL the server must not fetch. Phase 2 takes the candidate URL from
 * the CLIENT, so this is a real SSRF boundary, not a formality: without it a
 * caller could point the liveness check at localhost or the cloud metadata
 * endpoint (169.254.169.254) and use our server as a probe.
 */
export async function isFetchableUrl(raw: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return false
  }
  // A literal IP can be checked directly; a name has to be resolved first.
  if (net.isIP(host)) return !isPrivateAddress(host)
  try {
    const records = await dns.lookup(host, { all: true })
    return records.length > 0 && records.every((r) => !isPrivateAddress(r.address))
  } catch {
    return false // unresolvable → treat as dead
  }
}

/**
 * Server-side liveness backstop — we do NOT trust the model's claim that a URL
 * resolves. A fabricated URL fails DNS/connection (caught → not live); a dead
 * page returns 404/410. Bot-blocked-but-real sites (401/403/405/429) still
 * prove the domain exists, so we keep them. 5s timeout, follows redirects.
 */
export async function isLive(url: string): Promise<boolean> {
  if (!(await isFetchableUrl(url))) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; GrantOS-verifier/1.0; grant discovery link check)',
      },
    })
    return !(res.status === 404 || res.status === 410)
  } catch {
    return false // DNS failure, connection refused, or timeout → unreachable
  } finally {
    clearTimeout(timer)
  }
}

export type QualifiedGrant = Omit<DiscoveredGrant, 'source_url'> & {
  status: DiscoveryStatus
  /** Plain-language note on why it got this tier, shown in the UI. */
  status_note: string
}

export type QualifyResult =
  | { ok: true; grant: QualifiedGrant }
  | { ok: false; reason: string }

/**
 * The qualification contract for ONE grant. Runs after the Zod shape parse and
 * rejects anything that can't meet the app's minimum detail, so a half-populated
 * guess is never shown. Same rules as the old batch `qualify()`, one at a time.
 */
export async function qualifyOne(
  g: DiscoveredGrant,
  existingKeys: Set<string>
): Promise<QualifyResult> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // HARD DROPS — only things that are fake, dead, or already yours. Everything
  // else is kept and labelled. The old gate dropped anything it could not fully
  // confirm, which deleted most real foundation grants (see DISCOVERY_STATUSES).
  let parsed: URL
  try {
    parsed = new URL(g.url)
  } catch {
    return { ok: false, reason: 'unparseable URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'non-http(s) URL' }
  }

  const uKey = normalizeUrl(g.url)
  const nKey = nameKey(g.funder, g.name)
  if (existingKeys.has(uKey) || existingKeys.has(nKey)) {
    return { ok: false, reason: 'already in your pipeline' }
  }

  // A link that does not resolve is the one quality bar we keep absolutely:
  // it is the signal that the model invented the opportunity.
  if (!(await isLive(g.url))) return { ok: false, reason: 'link did not resolve' }

  // TIERING — decide how much to trust it, never whether to show it.
  let status: DiscoveryStatus
  let statusNote: string
  let deadline: string | null = null

  if (g.deadline_kind === 'fixed' && g.deadline) {
    const d = new Date(g.deadline)
    if (Number.isNaN(d.getTime())) {
      status = 'unconfirmed'
      statusNote = 'The deadline on the page could not be read.'
    } else if (d >= today) {
      status = 'open'
      statusNote = 'Open now, with a confirmed deadline.'
      deadline = g.deadline
    } else {
      // THE BIG ONE. A past deadline almost always means an annual program
      // between cycles, not a dead opportunity. Previously deleted outright.
      status = 'recurring'
      statusNote = g.next_cycle
        ? `Last cycle closed ${g.deadline}. Next cycle: ${g.next_cycle}.`
        : `Last cycle closed ${g.deadline} — likely annual, worth checking for the next round.`
    }
  } else if (g.deadline_kind === 'rolling') {
    status = 'open'
    statusNote = 'Accepts applications year-round.'
  } else if (g.deadline_kind === 'annual') {
    status = 'recurring'
    statusNote = g.next_cycle
      ? `Annual program. Next cycle: ${g.next_cycle}.`
      : 'Annual program — check back for the next cycle.'
  } else {
    status = 'unconfirmed'
    statusNote = 'Real funder page, but the deadline was not stated — worth checking directly.'
  }

  // A missing eligibility statement downgrades confidence; it no longer deletes
  // the opportunity, because plenty of real funders never publish one.
  if (!g.eligibility.trim() && status === 'open') {
    status = 'unconfirmed'
    statusNote = `${statusNote} Eligibility was not stated on the page.`
  }

  const { source_url: _src, ...rest } = g
  void _src
  return { ok: true, grant: { ...rest, deadline, status, status_note: statusNote } }
}

/**
 * Dedup keys for everything already in this org's pipeline, so discovery never
 * re-offers a grant the team has already imported. ORG-SCOPED.
 */
export async function loadExistingKeys(orgId: ObjectId): Promise<Set<string>> {
  const grantsCol = await grants()
  const existing = await grantsCol
    .find({ org_id: orgId })
    .project({ url: 1, funder: 1, name: 1 })
    .toArray()
  const keys = new Set<string>()
  for (const g of existing) {
    if (g.url) keys.add(normalizeUrl(g.url))
    if (g.funder && g.name) keys.add(nameKey(g.funder, g.name))
  }
  return keys
}

export interface OrgContext {
  name: string
  ein: string
  instructions: string
  company: string
}

/** Org identity + house instructions + KB facts, so the model judges fit. */
export async function loadOrgContext(orgId: ObjectId): Promise<OrgContext> {
  const orgsCol = await orgs()
  const [org, instructions, company] = await Promise.all([
    orgsCol.findOne({ _id: orgId }),
    getActiveInstructions(orgId),
    getCompanyContext(orgId),
  ])
  return {
    name: org?.name ?? 'Unknown organization',
    ein: org?.ein ?? '',
    instructions,
    company,
  }
}
