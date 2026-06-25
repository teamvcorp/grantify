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

const BASE = 'https://api.grants.gov/v1/api'

export type GrantsGovStatus = 'forecasted' | 'posted' | 'closed' | 'archived'

export interface GrantsGovSearchParams {
  keyword?: string
  oppNum?: string
  eligibilities?: string
  agencies?: string
  /** Comma-separated subset of GrantsGovStatus; defaults to "posted" (open). */
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

export async function searchGrantsGov(
  params: GrantsGovSearchParams
): Promise<GrantsGovSearchData> {
  const body = {
    rows: 25,
    oppStatuses: 'posted',
    ...params,
  }
  return post<GrantsGovSearchData>('/search2', body)
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
