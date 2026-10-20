"use client";

import { useActionState, useRef, useTransition } from "react";
import { toast } from "sonner";

import { ItemList, ItemRow } from "@/components/item-list";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { addPortalReaders, removePortalReader } from "@/server/portal-settings";

type Reader = { email: string; addedAt: string; addedBy: string | null };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings → Portal access, on a private portal: the people who may read it by email, besides the
 * team and SSO users. Adding them emails each a link to the portal (when email is set up).
 */
export function PortalReaders({ projectSlug, readers }: { projectSlug: string; readers: Reader[] }) {
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(async (prev: { error?: string }, formData: FormData) => {
    const result = await addPortalReaders(projectSlug, prev, formData);
    if (!result.error) {
      form.current?.reset();
      const added = result.added ?? 0;
      const emailed = result.emailed ?? 0;
      toast.success(
        added === 0
          ? "They're already readers"
          : emailed === added
            ? `${plural(added, "reader")} added; we emailed them a link`
            : emailed > 0
              ? `${plural(added, "reader")} added; we emailed ${emailed} of them`
              : `${plural(added, "reader")} added`,
      );
    }
    return result;
  }, {});

  return (
    <section aria-labelledby="portal-readers" className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-col gap-1">
        <h3 id="portal-readers" className="font-medium">
          Readers
        </h3>
        <p className="text-sm text-muted-foreground">
          People outside your team who may read the portal. They sign in with their address: an emailed sign-in link works even
          without an account.
        </p>
      </div>
      <form ref={form} {...keepingFields(action)} className="flex flex-col gap-2">
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="portal-reader-emails">Email addresses</FieldLabel>
          <Textarea
            id="portal-reader-emails"
            name="emails"
            rows={2}
            required
            placeholder="ada@example.com, grace@example.com"
            aria-invalid={state.error ? true : undefined}
          />
          <FieldDescription>Up to 20 at once, separated by commas or lines.</FieldDescription>
          {state.error && <FieldError>{state.error}</FieldError>}
        </Field>
        <div>
          <Button type="submit" disabled={pending}>
            Add readers
          </Button>
        </div>
      </form>
      {readers.length > 0 && (
        <ItemList>
          {readers.map((reader) => (
            <ItemRow
              key={reader.email}
              title={<span className="break-all">{reader.email}</span>}
              meta={`Added ${timeAgo(new Date(reader.addedAt))}${reader.addedBy ? ` by ${reader.addedBy}` : ""}`}
              actions={<RemoveReaderButton projectSlug={projectSlug} email={reader.email} />}
            />
          ))}
        </ItemList>
      )}
    </section>
  );
}

function RemoveReaderButton({ projectSlug, email }: { projectSlug: string; email: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={pending} aria-label={`Remove ${email}`} />}>Remove</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Remove {email}?</AlertDialogTitle>
          <AlertDialogDescription>They can&apos;t read the portal until you add them again. Their account stays.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removePortalReader(projectSlug, email);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${email} removed`);
                }
              })
            }
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
