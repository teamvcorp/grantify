'use client'

import { useActionState } from 'react'
import { Input } from '@/components/catalyst/input'
import { Button } from '@/components/catalyst/button'
import { Field, Label } from '@/components/catalyst/fieldset'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2 } from 'lucide-react'
import { authenticate } from './actions'

export default function LoginPage() {
  const [error, action, pending] = useActionState(authenticate, undefined)

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-6 py-8">
          <div className="space-y-2 text-center">
            <span className="mx-auto grid h-9 w-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
              G
            </span>
            <h1 className="text-xl font-semibold tracking-tight">Grantify</h1>
            <p className="text-sm text-muted-foreground">Sign in to your workspace</p>
          </div>

          <form action={action} className="space-y-5">
            <Field>
              <Label>Email</Label>
              <Input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field>
              <Label>Password</Label>
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <Button type="submit" color="emerald" className="w-full" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
