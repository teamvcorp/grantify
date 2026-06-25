# Grants.gov API notes (saved locally to avoid re-researching)

The federal Grants.gov **Search2** REST API is public and **requires no API key** for
opportunity search/fetch. Base host: `https://api.grants.gov/v1/api`.

## Search opportunities — `POST /v1/api/search2`

Content-Type: `application/json`. Request body (all optional except practically `rows`):

| Field | Type | Notes |
|---|---|---|
| `keyword` | string | Free-text search |
| `oppNum` | string | Opportunity number |
| `eligibilities` | string | Comma-separated codes |
| `agencies` | string | Comma-separated agency codes |
| `oppStatuses` | string | Comma-separated of `forecasted,posted,closed,archived`. Default `posted` is the useful one for open grants. |
| `aln` | string | Assistance Listing Number (formerly CFDA) |
| `fundingCategories` | string | Comma-separated category codes |
| `rows` | number | Page size (e.g. 25) |
| `startRecordNum` | number | Offset for pagination (0-based) |
| `sortBy` | string | e.g. `openDate|desc` |

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
