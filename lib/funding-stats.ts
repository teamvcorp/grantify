import { getDb } from './mongodb'

/**
 * Public marketing funding stats for the landing hero. Numbers are an ESTIMATE:
 * live count of open federal opportunities per category (from Grants.gov) ×
 * a per-category average award. The monthly cron (/api/cron/funding-stats)
 * refreshes the counts; defaults below render the hero before it first runs.
 *
 * Global (not org-scoped) — stored in the `funding_stats` collection.
 */

export interface FundingCategory {
  code: string // Grants.gov fundingCategories code
  label: string
  avgAward: number
}

// A marketable subset of Grants.gov funding categories.
export const FUNDING_CATEGORIES: FundingCategory[] = [
  { code: 'HL', label: 'Healthcare', avgAward: 1_200_000 },
  { code: 'ST', label: 'Research & Technology', avgAward: 2_000_000 },
  { code: 'ED', label: 'Education', avgAward: 900_000 },
  { code: 'HO', label: 'Housing', avgAward: 1_500_000 },
  { code: 'ENV', label: 'Environment', avgAward: 800_000 },
  { code: 'CD', label: 'Community Development', avgAward: 700_000 },
  { code: 'BC', label: 'Business & Startups', avgAward: 600_000 },
  { code: 'FN', label: 'Food & Nutrition', avgAward: 500_000 },
  { code: 'AR', label: 'Arts & Culture', avgAward: 250_000 },
]

export interface FundingStat {
  label: string
  amount: number
  open_count: number
}

// Rough estimates so the hero is never empty (replaced by the cron's live data).
export const DEFAULT_FUNDING_STATS: FundingStat[] = [
  { label: 'Healthcare', amount: 4_800_000_000, open_count: 4000 },
  { label: 'Research & Technology', amount: 4_200_000_000, open_count: 2100 },
  { label: 'Education', amount: 2_700_000_000, open_count: 3000 },
  { label: 'Housing', amount: 1_800_000_000, open_count: 1200 },
  { label: 'Environment', amount: 1_200_000_000, open_count: 1500 },
  { label: 'Community Development', amount: 900_000_000, open_count: 1300 },
  { label: 'Business & Startups', amount: 700_000_000, open_count: 1100 },
].sort((a, b) => b.amount - a.amount)

/** Read the latest stats (sorted desc). Build-safe: falls back to defaults. */
export async function getFundingStats(): Promise<FundingStat[]> {
  try {
    const db = await getDb()
    const docs = await db.collection('funding_stats').find({}).toArray()
    if (docs.length === 0) return DEFAULT_FUNDING_STATS
    return docs
      .map((d) => ({
        label: String(d.label),
        amount: Number(d.amount) || 0,
        open_count: Number(d.open_count) || 0,
      }))
      .filter((d) => d.amount > 0)
      .sort((a, b) => b.amount - a.amount)
  } catch {
    return DEFAULT_FUNDING_STATS
  }
}
