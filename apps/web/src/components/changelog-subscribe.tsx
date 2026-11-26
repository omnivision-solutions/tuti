"use client";

import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";

import { keepingFields } from "@/lib/forms";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { subscribeToChangelog } from "@/server/changelog-subscribe";

/**
 * "Get updates by email" on the portal's changelog (a plain section, under an entry): a link to confirm is emailed first (subscribeToChangelog). `inCard`:
 * just the form, in a card with its own heading (a board's Get updates).
 */
export function ChangelogSubscribe({
  projectSlug,
  email,
  inCard = false,
  bare = false,
}: {
  projectSlug: string;
  email?: string;
  inCard?: boolean;
  /** Its heading and the form, without the card (the changelog's Subscribe popover). */
  bare?: boolean;
}) {
  // Its own ids: the changelog shows it in its rail on wide screens and after the list below them.
  const t = useTranslations("changelog");
  const headingId = useId();
  const errorId = useId();
  const [state, action, pending] = useActionState(
    (_prev: { error?: string; sentTo?: string }, form: FormData) => subscribeToChangelog(projectSlug, form),
    {},
  );
  const form = (
    // The form stays (and its button keeps focus), with what was typed if it's refused; the answer is read out from here.
    <form {...keepingFields(action)} className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {inCard ? t("byEmailInCard") : t("byEmailIntro")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          name="email"
          type="email"
          aria-label={t("email")}
          placeholder="you@example.com"
          autoComplete="email"
          defaultValue={email}
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? errorId : undefined}
          className={inCard ? "min-w-0 flex-1 basis-32" : "min-w-0 flex-1 basis-56"}
        />
        {/* Disabled while it sends, but keeping its focus. */}
        <Button type="submit" variant={inCard ? "outline" : "default"} disabled={pending} focusableWhenDisabled>
          {pending ? t("sending") : t("subscribe")}
        </Button>
      </div>
      {state.error && <FieldError id={errorId}>{state.error}</FieldError>}
      <p role="status" className="text-sm break-words text-muted-foreground">
        {state.sentTo && !state.error ? t("checkInbox", { email: state.sentTo }) : ""}
      </p>
    </form>
  );
  if (bare) {
    return (
      <section role="region" aria-labelledby={headingId} className="flex flex-col gap-2">
        <h2 id={headingId} className="font-sans text-[0.9375rem] font-semibold">
          {t("getByEmail")}
        </h2>
        {form}
      </section>
    );
  }
  return inCard ? (
    form
  ) : (
    <section role="region" aria-labelledby={headingId} className="flex flex-col gap-1">
      <h2 id={headingId} className="font-heading text-lg font-semibold">
        {t("getByEmail")}
      </h2>
      {form}
    </section>
  );
}
