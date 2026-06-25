import type { Budget, Grant, GrantForm } from './types'

/** HTML-escape for safe interpolation into the email body. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render a complete grant application as a self-contained HTML document:
 * form answers grouped by section, the narrative, and the budget table.
 * Reused for emailing the grant (and a good base for a future PDF attachment).
 * Inline styles only, so it renders consistently in email clients.
 */
export function renderGrantHtml(grant: Grant, form: GrantForm | null, budget: Budget | null): string {
  const sections =
    form && form.fields.length
      ? form.sections
          .map((section) => {
            const rows = form.fields
              .filter((f) => f.section === section)
              .map(
                (f) =>
                  `<div style="margin:12px 0"><div style="font-weight:600">${esc(
                    f.question
                  )}</div><div style="white-space:pre-wrap">${
                    esc(f.answer) || '<span style="color:#999">—</span>'
                  }</div></div>`
              )
              .join('')
            return `<h2 style="font-size:15px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px">${esc(
              section
            )}</h2>${rows}`
          })
          .join('')
      : '<p style="color:#666">No application form has been generated yet.</p>'

  const narrative = form?.narrative_draft
    ? `<h2 style="font-size:15px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px">Narrative</h2><div style="white-space:pre-wrap">${esc(
        form.narrative_draft
      )}</div>`
    : ''

  let budgetHtml = ''
  if (budget && budget.items.length) {
    const total = budget.items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0)
    const rows = budget.items
      .map(
        (i) =>
          `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(
            i.category
          )}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(
            i.description
          )}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">$${(
            Number(i.amount) || 0
          ).toLocaleString()}</td></tr>`
      )
      .join('')
    budgetHtml = `<h2 style="font-size:15px;margin-top:24px;border-bottom:1px solid #ddd;padding-bottom:4px">Budget</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr><th style="text-align:left;padding:4px 8px">Category</th><th style="text-align:left;padding:4px 8px">Description</th><th style="text-align:right;padding:4px 8px">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="2" style="padding:6px 8px;font-weight:600;text-align:right">Total</td><td style="padding:6px 8px;font-weight:600;text-align:right">$${total.toLocaleString()}</td></tr></tfoot>
      </table>
      ${budget.notes ? `<p style="color:#444;white-space:pre-wrap">${esc(budget.notes)}</p>` : ''}`
  }

  return `<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:680px;margin:0 auto">
    <h1 style="font-size:20px;margin-bottom:4px">${esc(grant.name)}</h1>
    <p style="color:#666;margin-top:0">${esc(grant.funder)} · ${esc(grant.funder_type)}</p>
    ${sections}${narrative}${budgetHtml}
    <hr style="margin:32px 0;border:none;border-top:1px solid #eee"/>
    <p style="color:#999;font-size:12px">Sent from Grant OS.</p>
  </div>`
}
