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
import { knowledgeBase } from '@/lib/collections'
import { hasCredits, chargeUsage } from '@/lib/credits'
import { loadOrgContext } from '@/lib/discovery'
import { getOrgMission } from '@/lib/org-ai'
import {
  countFederalMatches,
  countFederalForPurpose,
  DEFAULT_ELIGIBILITY,
} from '@/lib/grantsgov'
import { FUNDER_TYPES, PurposeInput } from '@/lib/schemas'
import { purposes as purposesCol } from '@/lib/collections'

/**
 * POST /api/ai/purpose-portfolio — mission statement in, a PORTFOLIO of
 * fundable Purposes out, ranked by how much funding actually exists for each.
 *
 * WHY THIS EXISTS: most nonprofits run several programs at once, and the hard
 * question is not "describe one project" but "which of the things we already do
 * should we chase money for, and where is the money actually available?" So the
 * input is the org's mission/slogan plus example programs, and the output is
 * several candidate Purposes — each one scored against the LIVE federal index
 * before the user ever sees it.
 *
 * "Availability" is measured, not guessed: each proposal's focus areas are
 * probed individually, and the whole purpose is run through the same relaxation
 * ladder the real search uses, so `federal_hits` is the number of opportunities
 * the user would actually get. A proposal that reads well but has no funding
 * behind it sorts to the bottom and says so.
 *
 * Nothing is written. The user picks which proposals to create.
 *
 * SECURITY / multi-tenancy: org context and the existing-purpose list are
 * loaded by the caller's org_id.
 */

export const runtime = 'nodejs'
// One model call plus a burst of free Grants.gov probes.
export const maxDuration = 300

const MAX_PROPOSALS = 6

const BodySchema = z.object({
  /**
   * Mission statement, slogan and/or programs. OPTIONAL in the request — if the
   * org already has a mission on file we use that instead of making the user
   * retype it. A mission is REQUIRED overall: one source or the other must
   * supply it, because everything downstream is derived from it.
   */
  text: z.string().trim().max(6000).optional(),
  count: z.number().int().min(2).max(MAX_PROPOSALS).optional(),
})

/**
 * GET — does this org already have a mission on file?
 * The UI calls this BEFORE prompting, so a team that has already told us their
 * mission is never asked to paste it again.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  const mission = await getOrgMission(new ObjectId(session.user.org_id))
  return NextResponse.json({ mission, has_mission: mission.length > 0 })
}

const Proposal = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  focus_areas: z.array(z.string().trim().min(1)).min(1).max(6),
  geography: z.string().trim().max(80),
  target_amount: z.number().int().min(0).max(1_000_000_000),
  grant_types: z.array(z.enum(FUNDER_TYPES)),
  /** Which part of the mission/programs this came from, in plain words. */
  basis: z.string().trim().max(400).default(''),
})
const Proposals = z.array(Proposal)

function buildPrompt(
  text: string,
  count: number,
  existing: string[],
  org: { name: string; ein: string; instructions: string; company: string }
): string {
  const companyBlock = org.company
    ? `\nORGANIZATION KNOWLEDGE (facts already on file):\n${org.company}\n`
    : ''
  const existingBlock = existing.length
    ? `\nPURPOSES THIS ORG ALREADY TRACKS (do NOT propose duplicates of these):\n- ${existing.join('\n- ')}\n`
    : ''

  return `You are a grant strategist for a US nonprofit. From the organization's mission and programs below, propose ${count} DISTINCT fundable "Purposes" — separate funding pipelines the organization could pursue at the same time.

ORGANIZATION
- Name: ${org.name}
- EIN: ${org.ein || '(not provided)'}
${instructionsBlock(org.instructions)}${companyBlock}${existingBlock}
MISSION / SLOGAN / PROGRAMS AS THE USER DESCRIBED THEM
"""
${text}
"""

WHAT MAKES A GOOD PORTFOLIO:
- Each proposal is a SEPARATE program or service line that a funder would recognise as one project. Do not split one program into near-identical slices, and do not merge unrelated programs into a vague umbrella.
- Cover the range of what the organization actually does. If the text names distinct programs, each strong one deserves a proposal.
- If the text is only a mission or slogan with little detail, infer the concrete programs an organization with that mission typically runs, and say so in "basis".
- Vary the funder mix: some program types attract federal money, others only foundation or corporate money. Set "grant_types" honestly per proposal rather than listing every type on all of them.

HOW focus_areas WILL BE USED — this decides whether the proposal finds money:
They are sent VERBATIM as quoted search phrases to the federal Grants.gov API and as the search terms for an AI web search of private funders. They are search terms, not labels.
- Use the vocabulary FUNDERS use in program titles and eligibility text. Never invent an acronym or use internal branding.
- Give 3 to 4 phrases per proposal, most specific first.
- Balance them: include at least one phrase SPECIFIC enough to be precise, and at least one BROAD enough that real funding programs actually use those words. A phrase nothing matches is worthless, and a phrase everything matches is noise.
- No geography, dollar amounts or the organization's name inside a focus area.

OTHER FIELDS PER PROPOSAL:
- "name": a short project name a program officer would recognise.
- "description": 2-4 plain sentences — who is served, what is delivered, the outcome.
- "geography": EXACTLY "national", "state:XX" (two-letter code), or "city:Name".
- "target_amount": whole-dollar integer request size, inferred from scope.
- "grant_types": from ${FUNDER_TYPES.join(', ')}.
- "basis": 1-2 plain sentences on which part of the mission or which program this came from, so the user can tell whether you understood them.

Write plain text only — no Markdown, no asterisks.

Return ONLY a JSON array of exactly ${count} objects with EXACTLY these keys:
[{"name":string,"description":string,"focus_areas":string[],"geography":string,"target_amount":number,"grant_types":string[],"basis":string}]`
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
        { error: 'Paste your mission statement and a few of your programs first.' },
        { status: 400 }
      )
    }
    const count = parsed.data.count ?? 4
    const orgId = new ObjectId(session.user.org_id)

    // MISSION IS REQUIRED, but check what we already know before asking. Prefer
    // what the user typed now; otherwise use the mission on file.
    const typed = (parsed.data.text ?? '').trim()
    const stored = await getOrgMission(orgId)
    const mission = typed.length >= 20 ? typed : stored
    if (mission.length < 20) {
      return NextResponse.json(
        {
          error:
            'A mission statement is required. Add one to your knowledge base (category "Mission"), or paste your mission and main programs here.',
          needs_mission: true,
        },
        { status: 400 }
      )
    }

    // Remember a freshly-typed mission so nobody has to type it twice. Every
    // AI route already reads the knowledge base for org context, so this also
    // improves narratives, LOIs and discovery — not just this feature.
    let missionSaved = false
    if (typed.length >= 20 && !stored) {
      try {
        const kb = await knowledgeBase()
        const now = new Date()
        await kb.insertOne({
          org_id: orgId,
          purpose_id: null,
          question: 'What is our mission?',
          answer: typed,
          category: 'mission',
          tags: ['mission'],
          embedding_text: typed,
          times_used: 0,
          last_used: null,
          source_grant_id: null,
          created_at: now,
          updated_at: now,
        })
        missionSaved = true
      } catch {
        // Best effort — never fail the request over a convenience write.
      }
    }
    if (!(await hasCredits(orgId))) {
      return NextResponse.json(
        { error: 'Out of AI credits. Add credits from the dashboard to continue.' },
        { status: 402 }
      )
    }

    // Existing purposes, so the model proposes NEW pipelines rather than
    // re-suggesting what the team already tracks. ORG-SCOPED.
    const col = await purposesCol()
    const existingDocs = await col
      .find({ org_id: orgId })
      .project({ name: 1 })
      .limit(50)
      .toArray()
    const existing = existingDocs.map((d) => String(d.name)).filter(Boolean)

    const org = await loadOrgContext(orgId)
    const client = getAnthropic()
    const base = requestBaseFor('purpose-portfolio')
    const response = await client.messages.create({
      ...base,
      max_tokens: 8000,
      messages: [
        { role: 'user', content: buildPrompt(mission, count, existing, org) },
      ],
    })
    await chargeUsage(orgId, base.model, response.usage)

    const raw = Proposals.parse(parseJsonFromText(textFromMessage(response)))

    // MEASURE AVAILABILITY. Every proposal is checked against the live federal
    // index before the user sees it — per phrase, and as the whole purpose via
    // the same relaxation ladder the real search walks, so the number shown is
    // the number they would actually get. All probes are free and parallel.
    const measured = await Promise.all(
      raw.map(async (p) => {
        const [termHits, overall] = await Promise.all([
          // Same eligibility as the whole-purpose count, so the numbers the
          // user sees side by side answer the same question.
          Promise.all(p.focus_areas.map((t) => countFederalMatches(t, DEFAULT_ELIGIBILITY))),
          countFederalForPurpose(
            { name: p.name, focus_areas: p.focus_areas, geography: p.geography },
            DEFAULT_ELIGIBILITY
          ),
        ])
        const valid = PurposeInput.safeParse({
          name: p.name,
          description: p.description,
          focus_areas: p.focus_areas,
          geography: p.geography,
          target_amount: p.target_amount,
          grant_types: p.grant_types,
        })
        return {
          purpose: valid.success ? valid.data : null,
          basis: p.basis,
          focus_area_stats: p.focus_areas.map((term, i) => ({
            term,
            federal_hits: termHits[i],
          })),
          // Opportunities this purpose would actually surface today.
          federal_hits: overall.hits,
          // True when only a BROADENED query found anything — a weak signal
          // even when the count looks healthy, so the UI must not hide it.
          federal_broadened: overall.broadened,
        }
      })
    )

    // Drop anything that failed the real create schema, then rank by measured
    // availability. An exact-phrase match outranks a broadened one at the same
    // count, because broadened means the specific wording found nothing.
    const proposals = measured
      .filter((m) => m.purpose !== null)
      .sort((a, b) => {
        const aScore = a.federal_broadened ? a.federal_hits / 10 : a.federal_hits
        const bScore = b.federal_broadened ? b.federal_hits / 10 : b.federal_hits
        return bScore - aScore
      })

    if (proposals.length === 0) {
      return NextResponse.json(
        { error: 'Could not build usable purposes from that. Try adding more detail.' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      proposals,
      // Tell the UI where the mission came from, and whether we just saved it.
      mission_source: typed.length >= 20 ? 'entered' : 'on-file',
      mission_saved: missionSaved,
    })
  } catch (err) {
    console.error('[ai/purpose-portfolio] failed:', err)
    const raw = err instanceof Error ? err.message : ''
    const isUpstreamBody = /^\d{3}\s*[{[]/.test(raw.trim())
    const message =
      !raw || isUpstreamBody ? 'Could not build purposes. Please try again.' : raw
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
