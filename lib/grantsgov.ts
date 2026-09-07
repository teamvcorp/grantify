/**
 * Grants.gov Search2 API client.
 *
 * The federal Grants.gov search/fetch API is PUBLIC and needs no API key.
 * See docs/grants-gov-api.md for the full field reference.
 *
 * This module is server-side only (used by API routes). It does plain `fetch`
 * against https://api.grants.gov/v1/api — no SDK exists. Build-safe: no
 * top-level network calls or env reads that could throw at import.
 */

import {
  GRANTS_GOV_CATEGORIES,
  GRANTS_GOV_ELIGIBILITIES,
  DEFAULT_ELIGIBILITY,
} from './grantsgov-codes'

// Re-exported so server callers can keep importing everything from one place.
export { GRANTS_GOV_CATEGORIES, GRANTS_GOV_ELIGIBILITIES, DEFAULT_ELIGIBILITY }

const BASE = 'https://api.grants.gov/v1/api'

export type GrantsGovStatus = 'forecasted' | 'posted' | 'closed' | 'archived'

export interface GrantsGovSearchParams {
  keyword?: string
  oppNum?: string
  eligibilities?: string
  agencies?: string
  /**
   * ONE GrantsGovStatus; defaults to "posted" (open). NOT comma-separated —
   * "forecasted,posted" returns zero results. See QUERY SEMANTICS below.
   */
  oppStatuses?: string
  aln?: string
  fundingCategories?: string
  rows?: number
  startRecordNum?: number
  sortBy?: string
}

export interface GrantsGovOppHit {
  id: string
  number: string
  title: string
  agencyCode: string
  agency: string
  openDate: string // MM/DD/YYYY
  closeDate: string // MM/DD/YYYY
  oppStatus: string
  docType: string
  alnist?: string[]
}

export interface GrantsGovSearchData {
  hitCount: number
  startRecord: number
  oppHits: GrantsGovOppHit[]
}

interface GrantsGovEnvelope<T> {
  errorcode: number
  msg: string
  data: T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Don't cache federal data indefinitely; let callers cache deliberately.
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`Grants.gov ${path} failed: HTTP ${res.status}`)
  }

  const json = (await res.json()) as GrantsGovEnvelope<T>
  if (json.errorcode !== 0) {
    throw new Error(`Grants.gov ${path} error: ${json.msg || 'unknown error'}`)
  }
  return json.data
}

/**
 * QUERY SEMANTICS — verified live against the API on 2026-09-07. These are NOT
 * what the parameter names imply, and getting them wrong fails SILENTLY (an
 * empty result set, never an error). Evidence table in docs/grants-gov-api.md.
 *
 * 1. COMMA-SEPARATED LISTS DO NOT WORK. `fundingCategories:'ED'` → 146 hits and
 *    `'ST'` → 315, but `'ED,ST'` → **0**. Same for `eligibilities` ('12,99' → 0)
 *    and `oppStatuses` ('forecasted,posted' → 0). Send exactly ONE value per
 *    parameter. `assertSingleValue` turns a comma into a loud error so no caller
 *    can ship a query that silently returns nothing again.
 * 2. A bare multi-word keyword ORs, i.e. BROADENS: 'education youth STEM' → 485
 *    vs 129 for 'STEM' alone. A literal 'OR' is just matched as another word.
 * 3. QUOTING makes a term a narrowing phrase: '"early childhood"' → 24 vs 463
 *    unquoted. Multiple quoted phrases union cleanly (24 + 18 = 42).
 * 4. Filters (category/eligibility) AND against the keyword.
 *
 * Net rule: quote every term, and never send a comma.
 */
const SINGLE_VALUE_PARAMS = [
  'oppStatuses',
  'eligibilities',
  'fundingCategories',
] as const

function assertSingleValue(params: GrantsGovSearchParams): void {
  for (const key of SINGLE_VALUE_PARAMS) {
    const value = params[key]
    if (typeof value === 'string' && value.includes(',')) {
      throw new Error(
        `Grants.gov "${key}" does not support comma-separated values — ` +
          `"${value}" would silently return zero results. Send one value per request.`
      )
    }
  }
}

export async function searchGrantsGov(
  params: GrantsGovSearchParams
): Promise<GrantsGovSearchData> {
  assertSingleValue(params)
  const body = {
    rows: 25,
    oppStatuses: 'posted',
    ...params,
  }
  return post<GrantsGovSearchData>('/search2', body)
}

/**
 * Focus-area keyword → funding category. Only ONE category can be sent per
 * request, so we score the Purpose's focus areas against these hints and take
 * the strongest match. Deliberately conservative: no confident match means no
 * category filter at all, keeping recall rather than guessing a category and
 * silently hiding everything outside it.
 */
const CATEGORY_HINTS: Array<{ code: string; terms: string[] }> = [
  { code: 'ED', terms: ['education', 'school', 'student', 'literacy', 'teacher', 'tutor', 'stem', 'classroom', 'curriculum', 'scholarship'] },
  { code: 'HL', terms: ['health', 'medical', 'mental health', 'clinic', 'disease', 'wellness', 'substance', 'recovery', 'behavioral'] },
  // HO before ISS: homelessness is a housing issue, and on a tie the earlier
  // entry wins. (Measured: 'affordable housing' + 'homelessness' mis-suggested
  // ISS when ISS also claimed 'homeless'.)
  { code: 'HO', terms: ['affordable housing', 'housing', 'homeless', 'shelter', 'rental', 'homeownership'] },
  { code: 'ISS', terms: ['social service', 'poverty', 'income', 'welfare', 'family support', 'childcare', 'senior', 'disability'] },
  { code: 'FN', terms: ['food', 'nutrition', 'hunger', 'meal', 'pantry'] },
  { code: 'CD', terms: ['community development', 'neighborhood', 'revitalization', 'civic'] },
  { code: 'ENV', terms: ['environment', 'climate', 'conservation', 'pollution', 'sustainability', 'water quality'] },
  { code: 'ST', terms: ['research', 'science', 'technology', 'innovation', 'engineering'] },
  { code: 'AR', terms: ['art', 'arts', 'music', 'theater', 'culture', 'museum'] },
  { code: 'ELT', terms: ['workforce', 'employment', 'job training', 'apprentice', 'career', 'labor'] },
  { code: 'LJL', terms: ['justice', 'legal', 'reentry', 'victim', 'court', 'violence'] },
  { code: 'NR', terms: ['natural resource', 'wildlife', 'forest'] },
  { code: 'RT', terms: ['recreation', 'tourism', 'sport', 'athletic'] },
  { code: 'DPR', terms: ['disaster', 'emergency', 'resilience', 'preparedness'] },
  { code: 'AG', terms: ['agriculture', 'farm', 'rural'] },
  { code: 'BC', terms: ['business', 'entrepreneur', 'commerce'] },
]

/** The subset of a Purpose the federal query builder needs. */
export interface PurposeQueryInput {
  name: string
  focus_areas: string[]
  geography?: string
}

export interface DerivedFederalQuery {
  keyword: string
  /**
   * A category we think fits — OFFERED, never applied automatically.
   *
   * MEASURED 2026-09-07: auto-applying the category is destructive, because
   * Grants.gov's own category tagging is sparse. Hit counts for real purposes,
   * keyword + eligibility vs. that plus the category:
   *   Youth STEM Education      205 → 6
   *   Community Food Security    23 → 1
   *   Affordable Housing Access  17 → 1
   *   Workforce Development      87 → 0
   * So the UI surfaces this as a one-click "narrow to X" instead.
   */
  suggestedCategory?: string
  /** Human-readable notes for the UI, so the refinement is never invisible. */
  notes: string[]
}

/**
 * Words that carry no search signal in a Purpose name. Only used for the
 * no-focus-areas fallback below.
 */
const NAME_STOPWORDS = new Set([
  'a', 'an', 'and', 'for', 'of', 'the', 'to', 'in', 'on', 'with',
  'program', 'programs', 'project', 'projects', 'initiative', 'initiatives',
  'fund', 'funding', 'grant', 'grants', 'our', 'their',
])

/** Quote a term so Grants.gov treats it as a narrowing phrase, not loose words. */
function quoteTerm(term: string): string {
  return `"${term.trim().replace(/"/g, '')}"`
}

/**
 * Build a targeted Grants.gov query from a Purpose.
 *
 * keyword       ← focus_areas as QUOTED phrases (they union, so each term stays
 *                 precise while together they keep recall). Falls back to the
 *                 Purpose name when no focus areas are set.
 * category      ← best-scoring single match from the focus areas, else omitted.
 * geography     ← NOT USED. Search2 exposes no applicant-location filter, so we
 *                 do not fake one: a Purpose's "state:TX" cannot narrow federal
 *                 results (most federal programs are national anyway).
 * target_amount ← NOT USED. Award ceilings come back only from fetchOpportunity,
 *                 never from search2, so amount can't be filtered server-side.
 */
export function buildFederalQueryFromPurpose(
  purpose: PurposeQueryInput
): DerivedFederalQuery {
  const notes: string[] = []

  // Dedupe case-insensitively and drop blanks.
  const seen = new Set<string>()
  const all: string[] = []
  for (const raw of purpose.focus_areas ?? []) {
    const term = raw.trim()
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    all.push(term)
  }

  // PREFER SPECIFIC TERMS. Each phrase ORs into the result set, so an unbounded
  // list of generic words dilutes precision badly. Measured against the live
  // API: '"affordable housing"' alone returns 2 hits and the top result is the
  // Fair Housing Initiatives Program, while unioning it with 'homelessness'
  // returns 24 mostly-unrelated ones. Multi-word phrases are the most
  // discriminating, so rank by word count then length and keep only the best 3.
  const MAX_TERMS = 3
  const terms = [...all]
    .sort((a, b) => {
      const words = b.trim().split(/\s+/).length - a.trim().split(/\s+/).length
      return words !== 0 ? words : b.length - a.length
    })
    .slice(0, MAX_TERMS)

  let keyword: string
  if (terms.length > 0) {
    keyword = terms.map(quoteTerm).join(' ')
    notes.push(`Matching focus areas: ${terms.join(', ')}`)
  } else {
    // NO FOCUS AREAS. Quoting the whole name is far too specific — measured:
    // '"Rural Health Outreach"' returned ZERO hits. Quote each meaningful word
    // instead so they union, which keeps the search useful rather than empty.
    const words = purpose.name
      .split(/[^A-Za-z0-9]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w.toLowerCase()))
      .slice(0, 5)
    keyword = (words.length > 0 ? words : [purpose.name]).map(quoteTerm).join(' ')
    notes.push('No focus areas on this purpose — searching its name instead')
  }

  // Score categories by hint matches, weighting longer (more specific) hints so
  // 'affordable housing' outranks a bare 'housing' collision.
  const haystack = [...terms, purpose.name].join(' ').toLowerCase()
  let best: { code: string; score: number } | null = null
  for (const { code, terms: hints } of CATEGORY_HINTS) {
    const score = hints.reduce((n, h) => (haystack.includes(h) ? n + h.length : n), 0)
    if (score > 0 && (!best || score > best.score)) best = { code, score }
  }

  const derived: DerivedFederalQuery = { keyword, notes }
  if (best) {
    // Suggested only — see the note on DerivedFederalQuery.suggestedCategory.
    derived.suggestedCategory = best.code
  }
  return derived
}

export async function fetchGrantsGovOpportunity(
  opportunityId: string
): Promise<Record<string, unknown>> {
  return post<Record<string, unknown>>('/fetchOpportunity', { opportunityId })
}

/** Parse Grants.gov MM/DD/YYYY date strings into a Date, or null if invalid/empty. */
export function parseGrantsGovDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd))
  return Number.isNaN(date.getTime()) ? null : date
}

/** Public detail-page URL for an opportunity id. */
export function grantsGovUrl(id: string): string {
  return `https://www.grants.gov/search-results-detail/${id}`
}
