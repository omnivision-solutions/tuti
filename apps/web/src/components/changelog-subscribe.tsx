"use client";

import { useActionState, useId } from "react";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { subscribeToChangelog } from "@/server/changelog-subscribe";

/**
 * "Get updates by email" on the portal's changelog: a link to confirm is emailed first (subscribeToChangelog). `inCard`:
 * just the form, in a card with its own heading (a board's Get updates).
 */
export function ChangelogSubscribe({ projectSlug, email, inCard = false }: { projectSlug: string; email?: string; inCard?: boolean }) {
  // Its own ids: the changelog shows it in its rail on wide screens and after the list below them.
  const headingId = useId();
  const errorId = useId();
  const [state, action, pending] = useActionState(
    (_prev: { error?: string; sentTo?: string }, form: FormData) => subscribeToChangelog(projectSlug, form),
    {},
  );
  const form = (
    // The form stays (and its button keeps focus), with what was typed if it's refused; the answer is read out from here.
    <form {...keepingFields(action)} className="flex flex-col gap-2">
      {!inCard && <p className="text-sm text-muted-foreground">New entries in your inbox, each with a link to unsubscribe.</p>}
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
          aria-describedby={state.error ? errorId : undefined}
          className="min-w-0 flex-1 basis-56"
        />
        {/* Disabled while it sends, but keeping its focus. */}
        <Button type="submit" variant={inCard ? "outline" : "default"} disabled={pending} focusableWhenDisabled>
          {pending ? "Sending…" : "Subscribe"}
        </Button>
      </div>
      {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
      <p role="status" className="text-sm break-words text-muted-foreground">
        {state.sentTo && !state.error ? `Check your inbox: we sent a link to ${state.sentTo} to confirm.` : ""}
      </p>
    </form>
  );
  return inCard ? (
    form
  ) : (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-xs ring-1 ring-border">
      <h2 id={headingId} className="font-semibold">
        Get updates by email
      </h2>
      {form}
    </section>
  );
}
