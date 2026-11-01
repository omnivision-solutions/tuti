"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { subscribeToChangelog } from "@/server/changelog-subscribe";

/** "Get updates by email" on the portal's changelog: a link to confirm is emailed first (subscribeToChangelog). */
export function ChangelogSubscribe({ projectSlug, email }: { projectSlug: string; email?: string }) {
  const [state, action, pending] = useActionState(
    (_prev: { error?: string; sentTo?: string }, form: FormData) => subscribeToChangelog(projectSlug, form),
    {},
  );
  return (
    <section aria-labelledby="changelog-subscribe" className="flex flex-col gap-2 rounded-xl border p-4">
      <h2 id="changelog-subscribe" className="font-heading font-semibold">
        Get updates by email
      </h2>
      {/* The form stays (and its button keeps focus); the answer is read out from here. */}
      <form action={action} onSubmit={(event) => pending && event.preventDefault()} className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">New entries in your inbox as they&apos;re published. Unsubscribe from any of them.</p>
        <div className="flex flex-wrap gap-2">
          <Input
            name="email"
            type="email"
            aria-label="Email"
            placeholder="you@example.com"
            autoComplete="email"
            defaultValue={email}
            required
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "changelog-subscribe-error" : undefined}
            className="min-w-0 flex-1 basis-56"
          />
          {/* Not disabled while it sends: that would take its focus away. */}
          <Button type="submit" aria-disabled={pending}>
            {pending ? "Sending…" : "Subscribe"}
          </Button>
        </div>
        {state.error && <FieldError id="changelog-subscribe-error">{state.error}</FieldError>}
        <p role="status" className="text-sm text-muted-foreground">
          {state.sentTo && !state.error ? `Check your inbox: we sent a link to ${state.sentTo} to confirm.` : ""}
        </p>
      </form>
    </section>
  );
}
