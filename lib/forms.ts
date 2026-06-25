import type { GrantForm, GrantFormField } from './types'

/** Percent of fields with a non-empty answer (0–100). */
export function completedPct(fields: GrantFormField[]): number {
  if (fields.length === 0) return 0
  const filled = fields.filter((f) => f.answer && f.answer.trim().length > 0).length
  return Math.round((filled / fields.length) * 100)
}

/** Serialize a GrantForm for the client (ObjectId/Date → string). */
export function formToClient(f: GrantForm) {
  return {
    id: f._id?.toString(),
    grant_id: f.grant_id.toString(),
    fields: f.fields.map((x) => ({
      ...x,
      kb_match_id: x.kb_match_id ? x.kb_match_id.toString() : null,
    })),
    sections: f.sections,
    completed_pct: f.completed_pct,
    narrative_draft: f.narrative_draft,
    narrative_generated_at: f.narrative_generated_at
      ? f.narrative_generated_at.toISOString()
      : null,
    generated_at: f.generated_at ? f.generated_at.toISOString() : null,
  }
}
