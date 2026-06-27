import { ObjectId } from 'mongodb'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { getAnthropic, GRANT_OS_MODEL } from '@/lib/anthropic'
import { grants, grantForms } from '@/lib/collections'
import { logActivity } from '@/lib/activity'

/**
 * POST /api/ai/draft-narrative
 * Streams a long-form narrative draft for a grant, grounded in the form's
 * answered fields. Text is streamed to the client as it's generated and the
 * full draft is saved to the GrantForm when the stream completes.
 */
export const runtime = 'nodejs'
export const maxDuration = 120

const BodySchema = z.object({ grant_id: z.string().min(1) })

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.org_id) {
    return new Response('Not authenticated.', { status: 401 })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('Invalid JSON body.', { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success || !ObjectId.isValid(parsed.data.grant_id)) {
    return new Response('A valid grant_id is required.', { status: 400 })
  }

  const orgId = new ObjectId(session.user.org_id)
  const grantId = new ObjectId(parsed.data.grant_id)

  const grantsCol = await grants()
  const grant = await grantsCol.findOne({ _id: grantId, org_id: orgId })
  if (!grant) return new Response('Grant not found.', { status: 404 })

  const formsCol = await grantForms()
  const form = await formsCol.findOne({ grant_id: grantId, org_id: orgId })
  if (!form) return new Response('Generate a form first.', { status: 404 })

  const answered = form.fields.filter((f) => f.answer && f.answer.trim())
  if (answered.length === 0) {
    return new Response('Fill in some answers (e.g. via KB matching) first.', { status: 400 })
  }

  const prompt = `Write a compelling, well-structured grant narrative for the application below. Use ONLY the information in the answered fields — do not invent facts, figures, or outcomes. Write in clear, professional prose with short section headings. Aim for a cohesive narrative a reviewer would find persuasive.

GRANT: ${grant.name} — ${grant.funder} (${grant.funder_type})
${
  grant.requirements_raw
    ? `\nWHAT THE FUNDER FUNDS (align the emphasis, framing, and language to these priorities — but do not invent facts not supported by the answers below):\n${grant.requirements_raw}\n`
    : ''
}
ANSWERED FIELDS:
${answered.map((f) => `## ${f.question}\n${f.answer}`).join('\n\n')}

Write the narrative now.`

  const client = getAnthropic()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = ''
      try {
        const aiStream = client.messages.stream({
          model: GRANT_OS_MODEL,
          max_tokens: 8000,
          // Stream clean prose — no thinking blocks interleaved.
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: prompt }],
        })
        for await (const event of aiStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            full += event.delta.text
            controller.enqueue(encoder.encode(event.delta.text))
          }
        }
      } catch (err) {
        controller.error(err)
        return
      }

      // Persist the completed draft (best-effort) and log it.
      try {
        await formsCol.updateOne(
          { grant_id: grantId, org_id: orgId },
          {
            $set: {
              narrative_draft: full,
              narrative_generated_at: new Date(),
              last_updated: new Date(),
            },
          }
        )
        await logActivity({
          grant_id: grantId,
          org_id: orgId,
          user_id: new ObjectId(session.user.id),
          type: 'narrative_drafted',
          detail: 'Drafted the grant narrative.',
        })
      } catch {
        // Stream already delivered; ignore persistence hiccups.
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
