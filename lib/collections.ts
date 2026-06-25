import { getDb } from './mongodb'
import type {
  Activity,
  Grant,
  GrantForm,
  KnowledgeBaseEntry,
  Org,
  OrgDocument,
  Purpose,
  User,
} from './types'

/**
 * Typed collection accessors. Each returns the named collection typed against
 * its interface from `lib/types.ts`, so queries/inserts are checked at compile
 * time. All are async because they await the singleton Db.
 *
 * SECURITY NOTE: this app is multi-tenant. EVERY query against an org-scoped
 * collection MUST include `org_id` in the filter. These helpers don't enforce
 * that on their own — call sites are responsible. See NOTES.md.
 */

export async function purposes() {
  return (await getDb()).collection<Purpose>('purposes')
}

export async function grants() {
  return (await getDb()).collection<Grant>('grants')
}

export async function grantForms() {
  return (await getDb()).collection<GrantForm>('grant_forms')
}

export async function knowledgeBase() {
  return (await getDb()).collection<KnowledgeBaseEntry>('knowledge_base')
}

export async function documents() {
  return (await getDb()).collection<OrgDocument>('documents')
}

export async function orgs() {
  return (await getDb()).collection<Org>('orgs')
}

export async function users() {
  return (await getDb()).collection<User>('users')
}

export async function activities() {
  return (await getDb()).collection<Activity>('activities')
}
