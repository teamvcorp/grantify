import { ObjectId } from 'mongodb'
import { activities } from './collections'
import type { ActivityType } from './types'

/**
 * Append an entry to a grant's activity log. Best-effort — callers shouldn't fail
 * their main operation if logging hiccups, so this swallows errors.
 */
export async function logActivity(params: {
  grant_id: ObjectId
  org_id: ObjectId
  user_id: ObjectId
  type: ActivityType
  detail: string
}): Promise<void> {
  try {
    const col = await activities()
    await col.insertOne({ ...params, created_at: new Date() })
  } catch {
    // Non-fatal.
  }
}
