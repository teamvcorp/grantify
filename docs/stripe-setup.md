# Stripe setup & webhook report

How to configure Stripe for Grantify (getgrantify.com). The billing code is in
`lib/stripe.ts`, `lib/plan.ts`, and `app/api/billing/*`.

## 1. Environment variables

| Var | Where to get it | Status |
|-----|-----------------|--------|
| `STRIPE_SECRET_KEY` | Dashboard → Developers → API keys (`sk_test_…` / `sk_live_…`) | set (test) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | same page (`pk_test_…` / `pk_live_…`) | set (test) |
| `STRIPE_WEBHOOK_SECRET` | created when you add the webhook endpoint (step 3) — `whsec_…` | **needed** |
| `BASIC_GRANTS_PLAN` | Products → Basic → Price id (`price_…`) | set |
| `PRO_GRANTS_PLAN` | Products → Pro → Price id (`price_…`) | set |

> Use **test-mode** keys + a **test-mode** webhook together; switch all of them to live at launch.
> After changing env vars, restart the dev server (Next reads env at boot).

## 2. Products & prices

Two recurring products in **Stripe → Products**:

| Plan  | Price        | Env var holding the Price id |
|-------|--------------|------------------------------|
| Basic | $5 / month   | `BASIC_GRANTS_PLAN` |
| Pro   | $25 / month  | `PRO_GRANTS_PLAN`   |

These match `lib/plan.ts` (`PLANS`). Member caps enforced today: Free = 2, Basic = 10,
Pro = unlimited (gate is in `POST /api/team`; adjust caps in `lib/plan.ts`).

## 3. Webhook endpoint

**Dashboard → Developers → Webhooks → Add endpoint.**

- **Endpoint URL (production):** `https://www.getgrantify.com/api/billing/webhook`
- **API version:** default (latest) is fine — the SDK is version-pinned server-side.
- After creating it, copy the **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

### Events to enable

Select exactly these three — they are everything the handler
(`app/api/billing/webhook/route.ts`) acts on:

| Event | Handler action | Effect on the org |
|-------|----------------|-------------------|
| `checkout.session.completed` | Reads `metadata.org_id` + `metadata.plan`; stores customer + subscription ids | Sets `org.plan` to the purchased plan |
| `customer.subscription.updated` | Maps the subscription's price id → plan (`planFromPriceId`), checks status | Re-syncs `org.plan` on upgrade/downgrade; downgrades to `free` if not active |
| `customer.subscription.deleted` | Matches org by `stripe_subscription_id` | Sets `org.plan` = `free` |

> The update/delete events match the org by `stripe_subscription_id`, which is stored during
> `checkout.session.completed`. So the first successful checkout must complete before those two
> events can resolve — this is normal.

Adding more events does no harm (the handler ignores unrecognized types and returns 200), but
the three above are sufficient. Optional future additions (require handler changes first):
`invoice.payment_failed` (dunning/notify), `invoice.paid` (receipts).

## 4. Local testing (Stripe CLI)

```bash
stripe login
stripe listen --forward-to localhost:3000/api/billing/webhook
# copy the whsec_… it prints into STRIPE_WEBHOOK_SECRET, then restart `npm run dev`
stripe trigger checkout.session.completed
```

Test card for Checkout: `4242 4242 4242 4242`, any future expiry, any CVC/ZIP.

## 5. Flow recap

1. Admin clicks **Upgrade** in Settings → `POST /api/billing/checkout` creates a Checkout
   Session (with `metadata.org_id` + `plan`) and redirects to Stripe.
2. Payment completes → Stripe calls the webhook → `org.plan` updated.
3. **Manage billing** → `POST /api/billing/portal` opens the Stripe Customer Portal (cancel,
   change card, switch plan). Portal-initiated changes come back via
   `customer.subscription.updated` / `.deleted`.

## 6. Go-live checklist

- [ ] Live `STRIPE_SECRET_KEY` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- [ ] Live products + `BASIC_GRANTS_PLAN` / `PRO_GRANTS_PLAN`
- [ ] Live webhook at `https://www.getgrantify.com/api/billing/webhook` → live `STRIPE_WEBHOOK_SECRET`
- [ ] Enable the Customer Portal (Settings → Billing → Customer portal) in the Stripe dashboard
- [ ] Set all env vars in the Vercel project (not just `.env.local`)
