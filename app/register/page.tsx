'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Input } from '@/components/catalyst/input'
import { Button } from '@/components/catalyst/button'
import { Field, Label } from '@/components/catalyst/fieldset'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { register } from './actions'

export default function RegisterPage() {
  const [error, action, pending] = useActionState(register, undefined)

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 py-8">
          <div className="space-y-2 text-center">
            <span className="mx-auto grid h-9 w-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              G
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
            <p className="text-sm text-muted-foreground">
              Set up Grantify for your organization
            </p>
          </div>

          <form action={action} className="space-y-5">
            <Field>
              <Label>Your name</Label>
              <Input name="name" type="text" autoComplete="name" required />
            </Field>
            <Field>
              <Label>Organization name</Label>
              <Input name="org_name" type="text" autoComplete="organization" required />
            </Field>
            <Field>
              <Label>Email</Label>
              <Input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field>
              <Label>Password</Label>
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Field>

            {/* Honeypot — hidden from real users; bots that fill it are rejected. */}
            <input
              type="text"
              name="company_website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" color="emerald" className="w-full" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create account
            </Button>
          </form>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-emerald-600 hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
