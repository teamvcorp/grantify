import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  searchGrantsGov,
  parseGrantsGovDate,
  grantsGovUrl,
  type GrantsGovOppHit,
} from '@/lib/grantsgov'

/**
 * POST /api/grants/search
 * Search live federal opportunities via the public Grants.gov Search2 API.
 *
 * This route does NOT touch the database — it returns normalized results the
 * client can preview and selectively import into the `grants` collection.
 * Build-safe: no env vars required (Grants.gov needs no key).
 */

export const runtime = 'nodejs'

const SearchSchema = z.object({
  keyword: z.string().trim().max(200).optional(),
  oppStatuses: z.string().max(100).optional(), // e.g. "posted,forecasted"
  agencies: z.string().max(200).optional(),
  rows: z.number().int().min(1).max(100).optional(),
  startRecordNum: z.number().int().min(0).optional(),
})

/** Normalized hit shape returned to the client (maps onto our Grant schema). */
function normalize(hit: GrantsGovOppHit) {
  return {
    grantsgov_id: hit.id,
    number: hit.number,
    name: hit.title,
    funder: hit.agency,
    funder_type: 'federal' as const,
    status: hit.oppStatus,
    open_date: parseGrantsGovDate(hit.openDate),
    deadline_full: parseGrantsGovDate(hit.closeDate),
    url: grantsGovUrl(hit.id),
  }
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const parsed = SearchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  try {
    const data = await searchGrantsGov(parsed.data)
    return NextResponse.json({
      hitCount: data.hitCount,
      startRecord: data.startRecord,
      results: data.oppHits.map(normalize),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Grants.gov search failed.'
    // 502: upstream (Grants.gov) failure, not the client's fault.
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
