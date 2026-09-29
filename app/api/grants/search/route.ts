import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { purposes } from '@/lib/collections'
import {
  searchGrantsGov,
  parseGrantsGovDate,
  grantsGovUrl,
  buildFederalQueryFromPurpose,
  relevanceScore,
  GRANTS_GOV_CATEGORIES,
  GRANTS_GOV_ELIGIBILITIES,
  type GrantsGovOppHit,
} from '@/lib/grantsgov'

/**
 * POST /api/grants/search
 * Search live federal opportunities via the public Grants.gov Search2 API.
 *
 * PURPOSE-DRIVEN: pass `purpose_id` and the query is built FROM that Purpose
 * (focus areas → quoted keyword phrases, plus a best-match funding category)
 * instead of being a bare keyword passthrough. Previously the Purpose was only
 * an import target, so an empty search box returned the first 25 of every open
 * federal opportunity — the "off topic / unrefined" results. See NOTES.md.
 *
 * Grants.gov quirks that shape this route (verified live, see lib/grantsgov.ts):
 *   - comma-separated multi-value params silently return ZERO, so every filter
 *     here is single-valued and `searchGrantsGov` throws on a comma;
 *   - unquoted multi-word keywords BROADEN (they OR), quoted phrases narrow.
 *
 * SECURITY / multi-tenancy: the Purpose is loaded filtered by the caller's
 * org_id, never by id alone. The route now requires a session — it reads
 * org-scoped data, and it shouldn't be an open proxy to Grants.gov either.
 * Still writes nothing: results are previewed, then imported via POST /api/grants.
 */

export const runtime = 'nodejs'

const SearchSchema = z.object({
  /** When set, the query is derived from this Purpose (org-scoped). */
  purpose_id: z.string().min(1).optional(),
  /** Explicit override; wins over the Purpose-derived keyword when non-empty. */
  keyword: z.string().trim().max(200).optional(),
  // Single-valued by API constraint — a comma would silently zero the search.
  oppStatuses: z.enum(['posted', 'forecasted', 'closed', 'archived']).optional(),
  eligibilities: z.string().trim().max(4).optional(),
  fundingCategories: z.string().trim().max(4).optional(),
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

  const parsed = SearchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid search parameters.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }
  const input = parsed.data

  // Reject unknown codes up front — an invalid code is indistinguishable from
  // "no matches" in the response, which is exactly the trap we're closing.
  if (input.eligibilities && !GRANTS_GOV_ELIGIBILITIES[input.eligibilities]) {
    return NextResponse.json({ error: 'Unknown eligibility code.' }, { status: 400 })
  }
  if (input.fundingCategories && !GRANTS_GOV_CATEGORIES[input.fundingCategories]) {
    return NextResponse.json({ error: 'Unknown funding category code.' }, { status: 400 })
  }

  let keyword = input.keyword?.trim() || ''
  const fundingCategories = input.fundingCategories
  let suggestedCategory: string | null = null
  const notes: string[] = []
  // Broader keywords to retry if the primary returns nothing, and the terms we
  // re-rank the returned page against (both only exist for a purpose search).
  let fallbackKeywords: string[] = []
  let rankTerms: string[] = []

  // Derive the query from the Purpose unless the caller overrode a field.
  if (input.purpose_id) {
    if (!ObjectId.isValid(input.purpose_id)) {
      return NextResponse.json({ error: 'Invalid purpose_id.' }, { status: 400 })
    }
    const purposesCol = await purposes()
    const purpose = await purposesCol.findOne({
      _id: new ObjectId(input.purpose_id),
      org_id: new ObjectId(session.user.org_id), // ORG-SCOPED — never by id alone
    })
    if (!purpose) {
      return NextResponse.json({ error: 'Purpose not found.' }, { status: 404 })
    }

    const derived = buildFederalQueryFromPurpose({
      name: purpose.name,
      focus_areas: purpose.focus_areas ?? [],
      geography: purpose.geography,
    })
    rankTerms = purpose.focus_areas ?? []
    if (!keyword) {
      keyword = derived.keyword
      fallbackKeywords = derived.fallbackKeywords
      notes.push(...derived.notes)
    } else {
      notes.push('Using your keyword instead of the purpose’s focus areas')
    }

    // The category is SUGGESTED, never auto-applied. Measured against the live
    // API: forcing it collapses results (205→6, 87→0) because Grants.gov's own
    // category tagging is sparse. The client offers it as a one-click narrow.
    if (!fundingCategories && derived.suggestedCategory) {
      suggestedCategory = derived.suggestedCategory
    }
  }

  // Guard the original complaint: with no purpose and no keyword this endpoint
  // used to dump the first 25 of ~1000 unrelated opportunities.
  if (!keyword && !fundingCategories && !input.eligibilities && !input.agencies) {
    return NextResponse.json(
      {
        error:
          'Select a purpose or enter a keyword — an unfiltered search just returns every open federal opportunity.',
      },
      { status: 400 }
    )
  }

  try {
    const common = {
      oppStatuses: input.oppStatuses,
      eligibilities: input.eligibilities,
      fundingCategories,
      agencies: input.agencies,
      rows: input.rows,
      startRecordNum: input.startRecordNum,
    }

    // RELAXATION LADDER. A quoted phrase is an EXACT match, so a very specific
    // purpose can match nothing at all — measured: an AI-drafted purpose gave
    // 0 hits where the naive keyword "youth programs" gave 3. Precision is
    // worthless if the result set is empty, so walk to broader keywords until
    // something comes back. Only runs when the caller did not pin a keyword.
    let data = await searchGrantsGov({ keyword: keyword || undefined, ...common })
    for (const fallback of fallbackKeywords) {
      if (data.hitCount > 0) break
      notes.push(`No matches for ${keyword} — broadened to ${fallback}`)
      keyword = fallback
      data = await searchGrantsGov({ keyword: fallback, ...common })
    }

    // RE-RANK the page we were given. Grants.gov has no relevance sort (results
    // are date-ordered) and matches full text across the whole synopsis, so a
    // grant that merely mentions a term sits alongside one that is about it.
    // A term in the TITLE is the strongest fit signal available to us.
    // NOTE: this re-orders the current page only — it cannot reach hits on
    // later pages, because the API gives us no way to rank server-side.
    const ranked =
      rankTerms.length > 0
        ? [...data.oppHits]
            .map((h, i) => ({ h, i, s: relevanceScore(h.title, rankTerms) }))
            // Stable: equal scores keep the API's original (date) order.
            .sort((a, b) => (b.s - a.s) || (a.i - b.i))
            .map((x) => x.h)
        : data.oppHits

    // LOW-CONFIDENCE DETECTION. If we had to broaden AND nothing on the page
    // even mentions the purpose's terms in its title, these are almost
    // certainly not real matches — federal simply has nothing for this project.
    // Say so plainly instead of dressing up noise as results; the user's time
    // is better spent on AI discovery of private funders.
    const broadened = notes.some((n) => n.startsWith('No matches for'))
    const bestScore = rankTerms.length
      ? Math.max(0, ...ranked.map((h) => relevanceScore(h.title, rankTerms)))
      : 1
    // Covers BOTH shapes of "federal has nothing for this": an empty result
    // set after broadening, and a non-empty one where nothing matches. Both
    // mean the same thing to the user, and both should send them to AI
    // discovery rather than leaving them staring at a dead end.
    const lowConfidence = broadened && (data.hitCount === 0 || bestScore === 0)

    return NextResponse.json({
      hitCount: data.hitCount,
      startRecord: data.startRecord,
      results: ranked.map(normalize),
      // True when the results came only from broadening and match nothing in
      // the purpose — the UI warns rather than implying these are good hits.
      low_confidence: lowConfidence,
      // Echo what actually ran so the UI can show why these results came back.
      applied: {
        keyword,
        fundingCategories: fundingCategories ?? null,
        eligibilities: input.eligibilities ?? null,
        notes,
        // Pin the RESOLVED keyword so paging replays the same search rather
        // than re-running the relaxation ladder on every page.
        resolved_keyword: keyword,
        // Ranked client-side; say so rather than implying the API did it.
        ranked: rankTerms.length > 0,
        // Offered as a one-click narrowing, deliberately not applied.
        suggested_category: suggestedCategory,
        suggested_category_label: suggestedCategory
          ? (GRANTS_GOV_CATEGORIES[suggestedCategory] ?? suggestedCategory)
          : null,
      },
    })
  } catch (err) {
    console.error('[grants/search] failed:', err)
    const message = err instanceof Error ? err.message : 'Grants.gov search failed.'
    // 502: upstream (Grants.gov) failure, not the client's fault.
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
