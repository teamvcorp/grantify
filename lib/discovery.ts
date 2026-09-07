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
export const DiscoveredGrant = z.object({
  name: z.string().trim().min(1),
  funder: z.string().trim().min(1),
  funder_type: z.enum(['federal', 'foundation', 'state', 'corporate', 'other']),
  amount_min: z.number().nullable(),
  amount_max: z.number().nullable(),
  deadline_kind: z.enum(['fixed', 'rolling']),
  deadline: z.string().nullable(), // ISO "YYYY-MM-DD" when kind==='fixed'
  url: z.string().url(),
  source_url: z.string().url(), // the page the model actually opened to verify
  eligibility: z.string().trim().min(1),
  focus_areas: z.array(z.string()),
  summary: z.string(),
})
export type DiscoveredGrant = z.infer<typeof DiscoveredGrant>

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

export type QualifyResult =
  | { ok: true; grant: Omit<DiscoveredGrant, 'source_url'> }
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

  let parsed: URL
  try {
    parsed = new URL(g.url)
  } catch {
    return { ok: false, reason: 'unparseable URL' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'non-http(s) URL' }
  }

  // Deadline rule: fixed → valid, not-past date; rolling → date must be null.
  let deadline: string | null = null
  if (g.deadline_kind === 'fixed') {
    if (!g.deadline) return { ok: false, reason: 'fixed deadline with no date' }
    const d = new Date(g.deadline)
    if (Number.isNaN(d.getTime())) return { ok: false, reason: 'invalid deadline' }
    if (d < today) return { ok: false, reason: 'deadline already passed' }
    deadline = g.deadline
  }

  const uKey = normalizeUrl(g.url)
  const nKey = nameKey(g.funder, g.name)
  if (existingKeys.has(uKey) || existingKeys.has(nKey)) {
    return { ok: false, reason: 'already in your pipeline' }
  }

  if (!(await isLive(g.url))) return { ok: false, reason: 'link did not resolve' }

  const { source_url: _src, ...rest } = g
  void _src
  return { ok: true, grant: { ...rest, deadline } }
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
