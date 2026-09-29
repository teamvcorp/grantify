import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import {
  getAnthropic,
  requestBaseFor,
  textFromMessage,
  parseJsonFromText,
} from '@/lib/anthropic'
import { instructionsBlock } from '@/lib/org-ai'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { loadOrgContext } from '@/lib/discovery'
import { FUNDER_TYPES, PurposeInput } from '@/lib/schemas'

/**
 * POST /api/ai/purpose-assist — turn a plain-English description of a project
 * into a well-formed Purpose.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: the Purpose is now the input to BOTH
 * search paths. `focus_areas` become the literal QUOTED PHRASES sent to
 * Grants.gov (lib/grantsgov.ts → buildFederalQueryFromPurpose) and the search
 * terms for AI discovery. So the quality of these few strings decides the
 * quality of every result the user ever sees, and a vague purpose poisons both
 * paths at the source. The prompt below therefore optimizes the focus areas as
 * SEARCH TERMS, not as prose.
 *
 * Measured basis for that instruction (see docs/grants-gov-api.md):
 *   "affordable housing"  → 2 hits, top result is the Fair Housing Initiatives Program
 *   education/youth/STEM  → 485 hits, mostly unrelated
 * Specific multi-word phrases are precise; generic single words are noise.
 *
 * Returns a DRAFT only — nothing is written. The client fills the create form
 * with it so the user reviews and edits before saving.
 *
 * SECURITY / multi-tenancy: org context is loaded by the caller's org_id.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

const BodySchema = z.object({
  text: z.string().trim().min(10).max(4000),
})

/** Same shape as PurposeInput, but everything is a suggestion to be edited. */
const Draft = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  focus_areas: z.array(z.string().trim().min(1)).min(1).max(8),
  geography: z.string().trim().max(80),
  target_amount: z.number().int().min(0).max(1_000_000_000),
  grant_types: z.array(z.enum(FUNDER_TYPES)),
  /** Short plain-text note on the choices, shown under the form. */
  rationale: z.string().trim().max(600).default(''),
})

function buildPrompt(
  text: string,
  org: { name: string; ein: string; instructions: string; company: string }
): string {
  const companyBlock = org.company
    ? `\nORGANIZATION KNOWLEDGE (facts about this nonprofit):\n${org.company}\n`
    : ''

  return `You are helping a US nonprofit define a fundable "Purpose" (a project they want grant money for) inside a grant-search tool.

APPLICANT ORGANIZATION
- Name: ${org.name}
- EIN: ${org.ein || '(not provided)'}
${instructionsBlock(org.instructions)}${companyBlock}
WHAT THE USER TYPED
"""
${text}
"""

HOW THIS PURPOSE WILL BE USED — read this carefully, it decides the field values:
The "focus_areas" you return are not labels. They are sent VERBATIM as quoted search phrases to the federal Grants.gov API, and used as the search terms for an AI web search of private funders. Result quality depends almost entirely on them.

Evidence from the live federal API:
- "affordable housing" (a specific two-word phrase) returned 2 opportunities, the top one being exactly on point.
- "education", "youth", "STEM" (generic single words) returned 485 mostly unrelated opportunities, because each word matches any grant that mentions it anywhere.

RULES FOR focus_areas (most important field):
1. Prefer SPECIFIC MULTI-WORD PHRASES over single generic words. "early childhood literacy", not "education". "workforce reentry training", not "jobs".
2. Use the vocabulary FUNDERS use in program names and eligibility text, not internal or branded jargon. Never invent an acronym.
3. Give 3 to 5 phrases. Each one is OR'd with the others, so every extra generic phrase widens the results and dilutes precision.
4. Order them most-specific first.
5. Do not put the geography, the dollar amount, or the organization's name in a focus area.

OTHER FIELDS:
- "name": a short project name a program officer would recognize (max ~60 chars).
- "description": 2-4 plain sentences — who is served, what is delivered, the outcome. No marketing language.
- "geography": EXACTLY one of "national", "state:XX" (two-letter code), or "city:Name". Infer it from the text; use "national" if genuinely unclear.
- "target_amount": a whole-dollar integer request size. Infer from scope if not stated; 0 only if there is truly nothing to go on.
- "grant_types": which funder types plausibly fund this, from ${FUNDER_TYPES.join(', ')}.
- "rationale": 1-2 plain sentences telling the user WHY you chose these focus areas, so they can correct you.

Write plain text only — no Markdown, no asterisks, no bullet characters.

Return ONLY a JSON object (no prose, no code fences) with EXACTLY these keys:
{"name":string,"description":string,"focus_areas":string[],"geography":string,"target_amount":number,"grant_types":string[],"rationale":string}`
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
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Describe the project in a sentence or two first.' },
        { status: 400 }
      )
    }

    const orgId = new ObjectId(session.user.org_id)
    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    const org = await loadOrgContext(orgId)
    const client = getAnthropic()
    const base = requestBaseFor('purpose-assist')
    const response = await client.messages.create({
      ...base,
      max_tokens: 2000,
      messages: [{ role: 'user', content: buildPrompt(parsed.data.text, org) }],
    })
    await chargeUsage(orgId, base.model, response.usage)

    const draft = Draft.parse(parseJsonFromText(textFromMessage(response)))

    // Re-validate against the REAL create schema so the client can never be
    // handed a draft that /api/purposes would reject.
    const check = PurposeInput.safeParse({
      name: draft.name,
      description: draft.description,
      focus_areas: draft.focus_areas,
      geography: draft.geography,
      target_amount: draft.target_amount,
      grant_types: draft.grant_types,
    })
    if (!check.success) {
      return NextResponse.json(
        { error: 'The AI draft did not fit the purpose form. Try rephrasing.' },
        { status: 502 }
      )
    }

    return NextResponse.json({ draft: { ...check.data, rationale: draft.rationale } })
  } catch (err) {
    console.error('[ai/purpose-assist] failed:', err)
    const raw = err instanceof Error ? err.message : ''
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody ? 'Could not draft a purpose. Please try again.' : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
