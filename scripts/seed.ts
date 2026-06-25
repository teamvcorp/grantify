/**
 * Idempotent database seed for Grant OS.
 *
 * Creates (only what's missing): collection indexes, a default org, an admin user
 * with a hashed password, and a small set of example purpose/grants/KB entries so
 * a fresh install has something to look at. Safe to run repeatedly.
 *
 * Run:  npm run seed
 *   (which is: tsx --env-file=.env.local scripts/seed.ts)
 *
 * Requires in .env.local: MONGODB_URI, SEED_ORG_NAME, SEED_ADMIN_EMAIL,
 * SEED_ADMIN_PASSWORD. Optional: SEED_ORG_EIN.
 */
import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { getClient, getDb } from '../lib/mongodb'
import {
  activities,
  grants,
  knowledgeBase,
  orgs,
  purposes,
  users,
} from '../lib/collections'
import { hashPassword } from '../lib/password'

const envSchema = z.object({
  SEED_ORG_NAME: z.string().min(1, 'SEED_ORG_NAME is required'),
  SEED_ORG_EIN: z.string().optional().default(''),
  SEED_ADMIN_EMAIL: z.email('SEED_ADMIN_EMAIL must be a valid email'),
  SEED_ADMIN_PASSWORD: z
    .string()
    .min(8, 'SEED_ADMIN_PASSWORD must be at least 8 characters'),
})

async function ensureIndexes() {
  const db = await getDb()
  // Unique login identity.
  await db.collection('users').createIndex({ email: 1 }, { unique: true })
  // Tenant-scoped read paths (every query filters by org_id — see NOTES.md).
  await db.collection('users').createIndex({ org_id: 1 })
  await db.collection('purposes').createIndex({ org_id: 1 })
  await db.collection('grants').createIndex({ org_id: 1, purpose_id: 1 })
  await db.collection('grants').createIndex({ org_id: 1, status: 1 })
  await db.collection('knowledge_base').createIndex({ org_id: 1 })
  await db.collection('documents').createIndex({ org_id: 1, grant_id: 1 })
  await db.collection('activities').createIndex({ org_id: 1, grant_id: 1 })
  console.log('✓ indexes ensured')
}

async function main() {
  const env = envSchema.parse(process.env)
  const now = new Date()

  await ensureIndexes()

  // --- Org (upsert by name) ---
  const orgsCol = await orgs()
  let org = await orgsCol.findOne({ name: env.SEED_ORG_NAME })
  if (!org) {
    const res = await orgsCol.insertOne({
      name: env.SEED_ORG_NAME,
      ein: env.SEED_ORG_EIN,
      plan: 'free',
      stripe_customer_id: null,
      stripe_subscription_id: null,
      plan_expires_at: null,
      created_at: now,
    })
    org = await orgsCol.findOne({ _id: res.insertedId })
    console.log(`✓ created org "${env.SEED_ORG_NAME}"`)
  } else {
    console.log(`• org "${env.SEED_ORG_NAME}" already exists`)
  }
  const orgId = org!._id!

  // --- Admin user (upsert by email) ---
  const usersCol = await users()
  const existingUser = await usersCol.findOne({ email: env.SEED_ADMIN_EMAIL })
  if (!existingUser) {
    await usersCol.insertOne({
      org_id: orgId,
      email: env.SEED_ADMIN_EMAIL,
      name: 'Admin',
      role: 'admin',
      password_hash: await hashPassword(env.SEED_ADMIN_PASSWORD),
      avatar_url: null,
      created_at: now,
      last_login: null,
    })
    console.log(`✓ created admin user ${env.SEED_ADMIN_EMAIL}`)
  } else {
    console.log(`• user ${env.SEED_ADMIN_EMAIL} already exists (password unchanged)`)
  }

  // --- Example content (only if this org has no purposes yet) ---
  const purposesCol = await purposes()
  const hasPurpose = await purposesCol.findOne({ org_id: orgId })
  if (!hasPurpose) {
    const purposeRes = await purposesCol.insertOne({
      org_id: orgId,
      name: 'Youth STEM Education',
      description:
        'Fund after-school STEM programming for underserved middle-school students.',
      focus_areas: ['education', 'youth', 'STEM'],
      geography: 'state:TX',
      target_amount: 150000,
      grant_types: ['federal', 'foundation'],
      created_at: now,
      updated_at: now,
    })
    const purposeId = purposeRes.insertedId

    const grantsCol = await grants()
    await grantsCol.insertMany([
      {
        purpose_id: purposeId,
        org_id: orgId,
        name: 'Education Innovation and Research (EIR)',
        funder: 'U.S. Department of Education',
        funder_type: 'federal',
        amount_min: 100000,
        amount_max: 4000000,
        status: 'discovered',
        phase: 1,
        deadline_loi: null,
        deadline_full: null,
        deadline_report: null,
        url: 'https://www.grants.gov/',
        requirements_raw: '',
        focus_areas: ['education', 'STEM'],
        notes: 'Seeded example grant.',
        discovered_by: 'manual',
        grantsgov_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        purpose_id: purposeId,
        org_id: orgId,
        name: 'Community STEM Pathways Grant',
        funder: 'Example Family Foundation',
        funder_type: 'foundation',
        amount_min: 10000,
        amount_max: 50000,
        status: 'reviewing',
        phase: 2,
        deadline_loi: null,
        deadline_full: null,
        deadline_report: null,
        url: 'https://example.org/grants',
        requirements_raw: '',
        focus_areas: ['youth', 'STEM'],
        notes: 'Seeded example grant.',
        discovered_by: 'manual',
        grantsgov_id: null,
        created_at: now,
        updated_at: now,
      },
    ])

    const kbCol = await knowledgeBase()
    await kbCol.insertMany([
      {
        org_id: orgId,
        question: 'What is your organization mission?',
        answer:
          'We expand access to hands-on STEM education for underserved youth.',
        category: 'mission',
        tags: ['mission', 'overview'],
        embedding_text: 'mission STEM education underserved youth access',
        times_used: 0,
        last_used: null,
        source_grant_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        org_id: orgId,
        question: 'How many people does your program serve annually?',
        answer: 'Approximately 500 middle-school students across 12 schools.',
        category: 'outcomes',
        tags: ['outcomes', 'reach'],
        embedding_text: 'serve annually 500 students 12 schools reach impact',
        times_used: 0,
        last_used: null,
        source_grant_id: null,
        created_at: now,
        updated_at: now,
      },
    ])

    // Touch the activity log so the collection + index exist with real data.
    const activitiesCol = await activities()
    const firstGrant = await grantsCol.findOne({ org_id: orgId })
    if (firstGrant) {
      await activitiesCol.insertOne({
        grant_id: firstGrant._id!,
        org_id: orgId,
        user_id: orgId, // placeholder; replaced by real user id on first real action
        type: 'status_change',
        detail: 'Seeded example grant.',
        created_at: now,
      })
    }

    console.log('✓ seeded example purpose, grants, and knowledge base')
  } else {
    console.log('• example content already present (skipped)')
  }

  console.log('\nSeed complete.')
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Close the pooled client so the script process can exit.
    const client = await getClient().catch(() => null)
    await client?.close()
  })
