import type { ObjectId } from 'mongodb'
import { grantForms, grants, knowledgeBase } from './collections'
import type { KbCategory } from './types'

/** Best-effort KB category from a field's section/question text. */
function categorize(section: string, question: string): KbCategory {
  const t = `${section} ${question}`.toLowerCase()
  if (/budget|financ|revenue|expense|funding/.test(t)) return 'financials'
  if (/outcome|impact|result|evaluat|metric/.test(t)) return 'outcomes'
  if (/program|project|activit|service/.test(t)) return 'programs'
  if (/mission|vision|about|organization|history/.test(t)) return 'mission'
  if (/demographic|population|served|community|beneficiar/.test(t)) return 'demographics'
  return 'other'
}

/**
 * Feed the knowledge base FROM a grant's completed form: each answered field
 * becomes a reusable Q&A. New questions are inserted; existing questions (same
 * text, same org) have their answer refreshed. Idempotent. No-op if no form.
 *
 * Shared by the manual "promote" route and the auto-promote on submit, so the
 * upsert logic lives in one place.
 */
export async function promoteFormToKb(
  orgId: ObjectId,
  grantId: ObjectId
): Promise<{ added: number; updated: number; total: number }> {
  const formsCol = await grantForms()
  const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
  if (!form) return { added: 0, updated: 0, total: 0 }

  // Tie learned entries to the grant's Purpose (project).
  const grantsCol = await grants()
  const grant = await grantsCol.findOne({ _id: grantId, org_id: orgId })
  const purposeId = grant?.purpose_id ?? null

  const answered = form.fields.filter(
    (f) => f.type !== 'file' && f.answer && f.answer.trim().length > 0
  )

  const kb = await knowledgeBase()
  const now = new Date()
  let added = 0
  let updated = 0

  for (const f of answered) {
    const question = f.question.trim()
    const answer = f.answer.trim()
    const existing = await kb.findOne({ org_id: orgId, question })
    if (existing) {
      await kb.updateOne(
        { _id: existing._id },
        {
          $set: {
            answer,
            embedding_text: `${question}\n${answer}`,
            updated_at: now,
            // Adopt a purpose only if the entry didn't already have one.
            ...(existing.purpose_id ? {} : { purpose_id: purposeId }),
          },
        }
      )
      updated++
    } else {
      await kb.insertOne({
        org_id: orgId,
        purpose_id: purposeId,
        question,
        answer,
        category: categorize(f.section, question),
        tags: [],
        embedding_text: `${question}\n${answer}`,
        times_used: 0,
        last_used: null,
        source_grant_id: grantId,
        created_at: now,
        updated_at: now,
      })
      added++
    }
  }

  return { added, updated, total: answered.length }
}
