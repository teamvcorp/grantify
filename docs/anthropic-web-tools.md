# Anthropic server tools: web_search & web_fetch (saved reference)

Local copy so we don't re-research. Server-side (Anthropic-hosted) tools used by
`/api/ai/discover`. Sourced from the Anthropic API docs / claude-api skill.
Current as of 2026-08. Model in this repo: `claude-sonnet-4-6` (`GRANT_OS_MODEL`).

## Tool type strings (current)

| Tool | Current type | Name | Notes |
|---|---|---|---|
| Web search | `web_search_20260209` | `web_search` | "Dynamic filtering" variant. On Sonnet 4.6 / Opus 4.6+. Older models: `web_search_20250305`. On Vertex only the basic variant is available. |
| Web fetch | `web_fetch_20260209` | `web_fetch` | Opens a specific URL and reads the page. On Sonnet 4.6 / Opus 4.6+. No web_fetch on Vertex. |

Both are defined once in `lib/anthropic.ts` (`WEB_SEARCH_TOOL`, `WEB_FETCH_TOOL`)
and spread with a `max_uses` cap at the call site.

```ts
export const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search' }
export const WEB_FETCH_TOOL  = { type: 'web_fetch_20260209',  name: 'web_fetch'  }

const tools = [
  { ...WEB_SEARCH_TOOL, max_uses: 5 },        // cap total searches (latency)
  { ...WEB_FETCH_TOOL,  max_uses: 6 },        // cap total page fetches
]
```

### Useful options (per tool object)
- `max_uses` (number) — hard cap on invocations of that tool in the turn. Bound it
  to keep total latency under the serverless function limit.
- `allowed_domains` / `blocked_domains` (string[]) — restrict which hosts the tool
  may hit. Mutually exclusive per tool. Not currently used here; consider
  `allowed_domains` if we want to constrain fetches to known funder domains.
- `user_location` (web_search) — biases results geographically. Not used.
- `max_content_tokens` (web_fetch) — cap tokens pulled from a fetched page.

## Server-tool turn loop (`pause_turn`)

Server tools run on Anthropic's side mid-turn. The API may return
`stop_reason: "pause_turn"`; you must re-send the accumulated assistant turn to
resume until it finishes. Pattern used in `discover/route.ts`:

```ts
let response = await client.messages.create(params)
let guard = 0
while (response.stop_reason === 'pause_turn' && guard++ < 8) {
  messages.push({ role: 'assistant', content: response.content })
  response = await client.messages.create(params) // same params, messages mutated
}
```

Bound the loop (`guard`) so a stuck turn can't run forever. Fetch adds turns, so
this repo uses a higher bound (8) than the search-only version (5).

## Cost accounting

Server-tool usage comes back on `response.usage`:
- `usage.server_tool_use.web_search_requests` — number of searches performed.
- Token fields (`input_tokens`, `output_tokens`, `cache_*`) as usual.

`lib/credits.ts` bills `web_search_requests * WEB_SEARCH_PER_REQUEST` ($0.01 est.)
plus tokens, at the 2× margin. `chargeUsage` is called after EVERY turn (including
each `pause_turn` resume) so multi-turn tool loops are fully accounted. Web-fetch
request counts aren't separately surfaced today; fetched-page tokens are billed as
input tokens.

## Sonnet 4.6 constraints (repo-specific, also in NOTES.md)

- **No `budget_tokens`** on the `thinking` param for 4.6+. Use `{type:'adaptive'}`
  or `{type:'disabled'}`. Discovery uses `thinking:{type:'disabled'}` — on top of
  the web tools, enabling thinking pushed the call past the function time limit.
- **No `temperature`** passed (model default) on these calls.
- `max_tokens: 8000` for discovery.

## Discovery verification pattern (why we fetch, not just search)

Search returns snippets — good for finding candidates, weak for confirming a grant
is real and open. `/api/ai/discover` instructs the model to `web_fetch` each
candidate's real page to confirm funder, deadline (fixed date OR explicit rolling),
and eligibility, then a **server-side liveness check** (`isLive()` — GET, 5s
timeout, follow redirects; drop only DNS failures / 404 / 410) backstops the
model's `source_url` claim. Anything unverifiable is excluded. See the qualify()
gate in that route and NOTES.md → "Qualified non-federal discovery".
