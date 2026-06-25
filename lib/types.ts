import type { ObjectId } from 'mongodb'

/**
 * TypeScript shapes for every MongoDB collection.
 *
 * These mirror the documents stored in `grant_os`. We use the `mongodb` driver
 * directly (no Mongoose/ODM), so these interfaces are the single source of truth
 * for document shape — collection helpers in `lib/collections.ts` type each
 * collection against the matching interface here.
 *
 * Convention: `_id` is optional on the insert path (Mongo generates it) and
 * present on the read path. We keep it optional to reduce friction on inserts.
 */

export type FunderType = 'federal' | 'foundation' | 'state' | 'corporate'

export type GrantStatus =
  | 'discovered'
  | 'reviewing'
  | 'active'
  | 'submitted'
  | 'awarded'
  | 'rejected'
  | 'archived'

/** 6-phase roadmap — see PhaseTracker UI. */
export type GrantPhase = 1 | 2 | 3 | 4 | 5 | 6

export type FieldType = 'text' | 'textarea' | 'select' | 'date' | 'number' | 'file'

export type FieldSource = 'ai' | 'team' | 'kb' | 'empty'

export type DocumentCategory =
  | 'irs_letter'
  | 'financials'
  | 'board_list'
  | 'org_chart'
  | 'narrative'
  | 'budget'
  | 'support_letter'
  | 'other'

export type KbCategory =
  | 'mission'
  | 'financials'
  | 'programs'
  | 'outcomes'
  | 'demographics'
  | 'other'

export type UserRole = 'admin' | 'member' | 'viewer'

export type Plan = 'free' | 'basic' | 'pro'

export type ActivityType =
  | 'status_change'
  | 'phase_change'
  | 'note_added'
  | 'doc_uploaded'
  | 'form_generated'
  | 'narrative_drafted'
  | 'submitted'

export interface Purpose {
  _id?: ObjectId
  org_id: ObjectId
  name: string
  description: string
  focus_areas: string[]
  geography: string // "national" | "state:TX" | "city:Austin"
  target_amount: number
  grant_types: string[]
  created_at: Date
  updated_at: Date
}

export interface Grant {
  _id?: ObjectId
  purpose_id: ObjectId
  org_id: ObjectId
  name: string
  funder: string
  funder_type: FunderType
  amount_min: number
  amount_max: number
  status: GrantStatus
  phase: GrantPhase
  deadline_loi: Date | null
  deadline_full: Date | null
  deadline_report: Date | null
  url: string
  requirements_raw: string
  focus_areas: string[]
  notes: string
  discovered_by: 'ai' | 'manual'
  /** Grants.gov opportunity id when discovered via the Grants.gov API. */
  grantsgov_id?: string | null
  created_at: Date
  updated_at: Date
}

export interface GrantFormField {
  id: string // uuid
  question: string
  type: FieldType
  options: string[] // for select
  answer: string
  source: FieldSource
  kb_match_id: ObjectId | null
  required: boolean
  section: string
  word_limit: number | null
  char_limit: number | null
  help_text: string
}

export interface GrantForm {
  _id?: ObjectId
  grant_id: ObjectId
  org_id: ObjectId
  fields: GrantFormField[]
  sections: string[]
  generated_at: Date
  completed_pct: number // 0-100
  last_updated: Date
  narrative_draft: string
  narrative_generated_at: Date | null
}

export interface KnowledgeBaseEntry {
  _id?: ObjectId
  org_id: ObjectId
  question: string
  answer: string
  category: KbCategory
  tags: string[]
  embedding_text: string
  times_used: number
  last_used: Date | null
  source_grant_id: ObjectId | null
  created_at: Date
  updated_at: Date
}

export interface OrgDocument {
  _id?: ObjectId
  org_id: ObjectId
  grant_id: ObjectId | null // null = org-wide
  name: string
  category: DocumentCategory
  scope: 'org' | 'grant'
  blob_url: string
  file_type: string
  version: number
  uploaded_by: ObjectId
  uploaded_at: Date
}

export interface Org {
  _id?: ObjectId
  name: string
  ein: string
  plan: Plan
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan_expires_at: Date | null
  created_at: Date
}

export interface User {
  _id?: ObjectId
  org_id: ObjectId
  email: string
  name: string
  role: UserRole
  /** bcrypt/scrypt hash — never store plaintext. Optional for OAuth-only users. */
  password_hash?: string | null
  avatar_url: string | null
  created_at: Date
  last_login: Date | null
}

export interface Activity {
  _id?: ObjectId
  grant_id: ObjectId
  org_id: ObjectId
  user_id: ObjectId
  type: ActivityType
  detail: string
  created_at: Date
}

export interface BudgetLineItem {
  id: string // uuid
  category: string
  description: string
  amount: number
}

/** One budget per grant (line items + a notes block). */
export interface Budget {
  _id?: ObjectId
  org_id: ObjectId
  grant_id: ObjectId
  items: BudgetLineItem[]
  notes: string
  created_at: Date
  updated_at: Date
}
