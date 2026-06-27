import { z } from 'zod'

/**
 * Shared request validators. Keeping them here (rather than inline in each route)
 * avoids drift between the create and update paths.
 */

export const FUNDER_TYPES = ['federal', 'foundation', 'state', 'corporate'] as const

/** Input shape for creating/updating a Purpose (org_id + timestamps are server-set). */
export const PurposeInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(2000).default(''),
  focus_areas: z.array(z.string().trim().min(1)).max(20).default([]),
  geography: z.string().trim().max(80).default('national'),
  target_amount: z.number().int().min(0).max(1_000_000_000).default(0),
  grant_types: z.array(z.enum(FUNDER_TYPES)).default([]),
})

export type PurposeInput = z.infer<typeof PurposeInput>

export const GRANT_STATUSES = [
  'discovered',
  'reviewing',
  'active',
  'submitted',
  'awarded',
  'rejected',
  'archived',
] as const

/** Input for creating/importing a Grant (org_id + timestamps are server-set). */
export const GrantInput = z.object({
  purpose_id: z.string().min(1),
  name: z.string().trim().min(1).max(300),
  funder: z.string().trim().max(200).default(''),
  funder_type: z.enum(FUNDER_TYPES),
  amount_min: z.number().min(0).default(0),
  amount_max: z.number().min(0).default(0),
  status: z.enum(GRANT_STATUSES).default('discovered'),
  phase: z.number().int().min(1).max(6).default(1),
  // ISO date string or null; converted to Date server-side.
  deadline_full: z.string().nullable().default(null),
  url: z.string().trim().max(2000).default(''),
  requirements_raw: z.string().max(20000).default(''),
  focus_areas: z.array(z.string().trim().min(1)).max(30).default([]),
  notes: z.string().max(5000).default(''),
  discovered_by: z.enum(['ai', 'manual']).default('manual'),
  grantsgov_id: z.string().nullable().default(null),
})
export type GrantInput = z.infer<typeof GrantInput>

/** Partial update from the tracker UI — status / phase / notes. */
export const GrantPatch = z
  .object({
    status: z.enum(GRANT_STATUSES),
    phase: z.number().int().min(1).max(6),
    notes: z.string().max(5000),
  })
  .partial()

export const KB_CATEGORIES = [
  'mission',
  'financials',
  'programs',
  'outcomes',
  'demographics',
  'other',
] as const

/** Input for creating/updating a Knowledge Base entry (reusable Q&A). */
export const KbInput = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(10000),
  category: z.enum(KB_CATEGORIES).default('other'),
  tags: z.array(z.string().trim().min(1)).max(20).default([]),
  // Optional Purpose/project tie. '' or null = org-wide.
  purpose_id: z.string().nullable().optional(),
})
export type KbInput = z.infer<typeof KbInput>

export const USER_ROLES = ['admin', 'member', 'viewer'] as const

/** Organization profile edits (admin only). */
export const OrgUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  ein: z.string().trim().max(20).optional(),
})

/** Add a team member (admin only). */
export const MemberInput = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(USER_ROLES).default('member'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

/** Change a member's role and/or reset their password (admin only). */
export const MemberPatch = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
  })
  .refine((d) => d.role !== undefined || d.password !== undefined, {
    message: 'Provide a role or a password.',
  })

export const DOCUMENT_CATEGORIES = [
  'irs_letter',
  'financials',
  'board_list',
  'org_chart',
  'narrative',
  'budget',
  'support_letter',
  'other',
] as const

/** Replace a grant's budget (full PUT — items + notes). */
export const BudgetInput = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        category: z.string().trim().max(120).default(''),
        description: z.string().trim().max(500).default(''),
        amount: z.number().min(0).max(1_000_000_000).default(0),
      })
    )
    .max(200)
    .default([]),
  notes: z.string().max(5000).default(''),
})

/** Save edits to a generated GrantForm (manual field answers + narrative). */
export const FormPatch = z.object({
  answers: z
    .array(z.object({ id: z.string(), answer: z.string().max(20000) }))
    .max(500)
    .optional(),
  narrative_draft: z.string().max(100000).optional(),
})
