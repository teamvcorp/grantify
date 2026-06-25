import { NextResponse } from 'next/server'
import { ObjectId } from 'mongodb'
import { auth } from '@/lib/auth'
import { knowledgeBase } from '@/lib/collections'
import { KbInput } from '@/lib/schemas'
import type { KnowledgeBaseEntry } from '@/lib/types'

/**
 * /api/kb — list (GET) and create (POST) the org's Knowledge Base entries.
 * Reusable Q&A the AI form layer draws on to auto-fill applications.
 */
export const runtime = 'nodejs'

function toClient(e: KnowledgeBaseEntry) {
  return {
    id: e._id!.toString(),
    question: e.question,
    answer: e.answer,
    category: e.category,
    tags: e.tags,
    times_used: e.times_used,
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  const col = await knowledgeBase()
  const docs = await col
    .find({ org_id: new ObjectId(session.user.org_id) })
    .sort({ updated_at: -1 })
    .toArray()
  return NextResponse.json({ entries: docs.map(toClient) })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }
  const parsed = KbInput.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid entry.', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const now = new Date()
  const col = await knowledgeBase()
  const res = await col.insertOne({
    org_id: new ObjectId(session.user.org_id),
    ...parsed.data,
    // embedding_text is retained for a future Atlas Vector Search upgrade; for now
    // matching is Claude-judged (see NOTES.md), so we just store question + answer.
    embedding_text: `${parsed.data.question}\n${parsed.data.answer}`,
    times_used: 0,
    last_used: null,
    source_grant_id: null,
    created_at: now,
    updated_at: now,
  })
  const created = await col.findOne({ _id: res.insertedId })
  return NextResponse.json({ entry: toClient(created!) }, { status: 201 })
}
