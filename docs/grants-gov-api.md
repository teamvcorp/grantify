# Grants.gov API notes (saved locally to avoid re-researching)

The federal Grants.gov **Search2** REST API is public and **requires no API key** for
opportunity search/fetch. Base host: `https://api.grants.gov/v1/api`.

## Search opportunities — `POST /v1/api/search2`

Content-Type: `application/json`. Request body (all optional except practically `rows`):

| Field | Type | Notes |
|---|---|---|
| `keyword` | string | Free-text search |
| `oppNum` | string | Opportunity number |
| `eligibilities` | string | ONE code — a comma returns 0. See QUERY SEMANTICS. |
| `agencies` | string | ONE agency code (comma untested, assume single). |
| `oppStatuses` | string | ONE of `forecasted`/`posted`/`closed`/`archived` — a comma returns 0. Default `posted`. |
| `aln` | string | Assistance Listing Number (formerly CFDA) |
| `fundingCategories` | string | ONE category code — a comma returns 0. |
| `rows` | number | Page size (e.g. 25) |
| `startRecordNum` | number | Offset for pagination (0-based) |
| `sortBy` | string | e.g. `openDate|desc`. NO relevance sort — `relevance` returns 0. |

### Response shape
```jsonc
{
  "errorcode": 0,
  "msg": "success",
  "data": {
    "searchParams": { ... },
    "hitCount": 1234,
    "startRecord": 0,
    "oppHits": [
      {
        "id": "351083",          // opportunity id -> use for fetchOpportunity
        "number": "ABC-2026-001", // opportunity number
        "title": "...",
        "agencyCode": "HHS-ACF",
        "agency": "Administration for Children and Families",
        "openDate": "01/15/2026",  // MM/DD/YYYY
        "closeDate": "03/30/2026",
        "oppStatus": "posted",
        "docType": "synopsis",
        "alnist": ["93.600"]
      }
    ],
    "oppStatusOptions": [...],
    "eligibilities": [...],
    "fundingCategories": [...],
    "agencies": [...]
  }
}
```
`errorcode` 0 = success; non-zero -> `msg` has the error.

## Fetch one opportunity detail — `POST /v1/api/fetchOpportunity`
Body: `{ "opportunityId": "351083" }` (numeric id from `oppHits[].id`).
Returns `data` with full synopsis: `synopsis.synopsisDesc` (HTML description),
`synopsis.awardCeiling`, `synopsis.awardFloor`, `synopsis.estimatedFunding`,
`synopsis.responseDate` (close), `synopsis.agencyContactEmail`, eligibility text, etc.
Field availability varies by opportunity; treat all as possibly-missing.

## Mapping Grants.gov -> our `grants` schema
- `funder_type` => always `"federal"` for Grants.gov results
- `name` <= `title`; `funder` <= `agency`
- `url` <= `https://www.grants.gov/search-results-detail/{id}`
- `deadline_full` <= parse `closeDate` (MM/DD/YYYY) or `synopsis.responseDate`
- `amount_min`/`amount_max` <= `synopsis.awardFloor`/`awardCeiling` (from fetchOpportunity)
- `grantsgov_id` <= `id`
- `discovered_by` => `"manual"` (API-driven, deterministic) or a dedicated source tag

## Gotchas
- Dates are `MM/DD/YYYY` strings, not ISO. Parse carefully.
- Search2 returns lightweight hits; award amounts/description need fetchOpportunity.
- Public endpoint — still rate-limit politely; cache results per purpose.

## QUERY SEMANTICS — measured live 2026-09-07 (READ THIS FIRST)

The parameter names lie, and every mistake below fails **silently** as an empty
result set rather than an error. All numbers are real hit counts taken that day
(1024 posted opportunities in total).

### 1. Comma-separated lists DO NOT WORK — they return zero

| Query | Hits |
|---|---|
| `fundingCategories: "ED"` | 146 |
| `fundingCategories: "ST"` | 315 |
| `fundingCategories: "ED,ST"` | **0** |
| `eligibilities: "12"` | 495 |
| `eligibilities: "12,99"` | **0** |
| `oppStatuses: "posted"` | 1024 |
| `oppStatuses: "forecasted"` | 561 |
| `oppStatuses: "forecasted,posted"` | **0** |

The table earlier in this file describing these as "comma-separated" is WRONG —
it reflects the published docs, not observed behaviour. **Send exactly one value
per parameter.** `searchGrantsGov` now throws on a comma so this can't recur.
This bug shipped twice: it silently zeroed the funding-stats cron (see NOTES.md).

An invalid value behaves the same way: `sortBy: "relevance"` → 0 hits.

### 2. Bare multi-word keywords BROADEN (they OR)

| Keyword | Hits |
|---|---|
| `STEM` | 129 |
| `education youth STEM` | 485 |
| `education OR youth OR STEM` | 485 (the literal "OR" is just another word) |
| `education\|youth\|STEM` | 0 (no pipe syntax) |

### 3. Quoting makes a term a narrowing phrase

| Keyword | Hits |
|---|---|
| `early childhood` | 463 |
| `"early childhood"` | 24 |
| `"affordable housing"` | 2 |
| `"homelessness"` | 22 |
| `"affordable housing" "homelessness"` | 24 (= 2 + 22, a clean union) |

Quoted phrases union exactly, and quoting is preserved when several are sent.
Filters (category/eligibility) AND against the keyword.

### 4. There is NO relevance sort — results come back in date order

`sortBy: "relevance"` returns zero (invalid). This is why a correct match set can
still *look* random: Grants.gov matches full-text across the whole synopsis, so a
research grant that merely mentions "homelessness" ranks alongside a housing
program, and nothing orders by fit. Narrowing the match set is the only lever the
API gives us.

## Deriving a query from a Purpose

`buildFederalQueryFromPurpose` (lib/grantsgov.ts) turns a Purpose into a query:

- **keyword** ← focus areas as QUOTED phrases, ranked by specificity (word count,
  then length) and capped at 3 — each extra phrase ORs more results in.
  No focus areas → the purpose *name* split into quoted words. Do NOT quote the
  whole name: `"Rural Health Outreach"` returned **0**; the split form returns 282.
- **eligibility** ← defaults to `12` (501(c)(3) nonprofits) in the UI, adjustable.
  Tradeoff: it also hides the ~180 `99 / Unrestricted` opportunities, and multi-value
  is impossible, hence the "Any eligibility" option.
- **category** ← SUGGESTED ONLY, never auto-applied. Forcing it collapses results
  because Grants.gov's category tagging is sparse:

  | Purpose | keyword + eligibility | + category |
  |---|---|---|
  | Youth STEM Education | 205 | 6 |
  | Community Food Security | 23 | 1 |
  | Affordable Housing Access | 17 | 1 |
  | Workforce Development | 87 | **0** |

- **geography / target_amount** ← UNUSED, deliberately. Search2 has no applicant
  location filter, and award amounts only come from fetchOpportunity.
