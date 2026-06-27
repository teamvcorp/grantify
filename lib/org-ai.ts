import type { ObjectId } from 'mongodb'
import { knowledgeBase, orgs } from './collections'

/**
 * Org-level AI context shared by every AI grant operation:
 *  - active "house" instructions (voice, strategy, how to position the org)
 *  - company info distilled from the knowledge base
 * Both are woven into the prompts for funding summary, form generation,
 * narrative drafting, and per-field polishing so output is consistent and
 * tailored to make the org the best fit for each grant.
 */

export async function getActiveInstructions(orgId: ObjectId): Promise<string> {
  const org = await (await orgs()).findOne({ _id: orgId })
  return (org?.ai_instructions ?? '').trim()
}

/** Compact org facts from the knowledge base, for grounding (truncated). */
export async function getCompanyContext(orgId: ObjectId, limit = 40): Promise<string> {
  const kb = await (await knowledgeBase()).find({ org_id: orgId }).limit(limit).toArray()
  if (kb.length === 0) return ''
  return kb.map((e) => `- ${e.question}: ${e.answer}`).join('\n')
}

/** A prompt block for the house instructions, or '' when none are set. */
export function instructionsBlock(instructions: string): string {
  return instructions
    ? `\nORGANIZATION INSTRUCTIONS (follow these closely — they define the voice, strategy, and how to position this organization):\n${instructions}\n`
    : ''
}
