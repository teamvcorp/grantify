# Catalyst UI kit — usage notes

Company policy / reference: **https://catalyst.tailwindui.com/docs**
License: Tailwind Plus (commercial). Do **not** open-source/redistribute the components.

## Where it lives
- `catalyst-ui-kit/` — the downloaded kit (TypeScript + JavaScript copies). **Gitignored**
  (licensed source). Treat as read-only reference.
- Components we actually adopt are **copied into `components/`** and committed (standard Catalyst
  workflow — you copy what you use into your project).

## Dependencies
Catalyst components require:
```sh
npm install @headlessui/react motion clsx
```

## Design language (what we're borrowing)
- Neutral scale: zinc-based; we warm it slightly via the theme tokens in `app/globals.css`.
- Single accent color used for primary actions (Catalyst exposes many: indigo, emerald, teal,
  amber, etc. — see `catalyst-ui-kit/typescript/button.tsx`).
- Refined buttons (optical border + inner highlight), clear focus rings, generous radius.

## Integration note
The app's existing components in `components/ui/` are base-ui/shadcn (a different system). We are
lifting the **visual language** app-wide via theme tokens, and adopting Catalyst components on
high-visibility surfaces. This is a UI change only — no core app logic/data flow changes.
