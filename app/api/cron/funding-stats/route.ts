import { NextResponse } from 'next/server'
import { getDb } from '@/lib/mongodb'
import { searchGrantsGov } from '@/lib/grantsgov'
import { FUNDING_CATEGORIES } from '@/lib/funding-stats'

/**
 * GET /api/cron/funding-stats — monthly refresh of the landing hero figures.
 * For each funding category, pulls the live count of open federal opportunities
 * from Grants.gov and stores an estimated total (count × avg award).
 *
 * Scheduled by vercel.json. Protected by CRON_SECRET: Vercel sends it as
 * `Authorization: Bearer <CRON_SECRET>` when the env var is set.
 */
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const db = await getDb()
  const col = db.collection('funding_stats')
  const now = new Date()
  const results: { category: string; open_count: number; amount: number }[] = []

  for (const c of FUNDING_CATEGORIES) {
    try {
      const data = await searchGrantsGov({
        fundingCategories: c.code,
        oppStatuses: 'forecasted,posted',
        rows: 1,
      })
      const amount = data.hitCount * c.avgAward
      await col.updateOne(
        { category: c.code },
        {
          $set: {
            category: c.code,
            label: c.label,
            open_count: data.hitCount,
            amount,
            updated_at: now,
          },
        },
        { upsert: true }
      )
      results.push({ category: c.code, open_count: data.hitCount, amount })
    } catch {
      // Skip a category that errors; keep refreshing the rest.
    }
  }

  return NextResponse.json({ updated: results.length, results })
}
