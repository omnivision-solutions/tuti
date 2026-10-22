"use client";

import { ArrowRightIcon } from "lucide-react";
import { useActionState, useRef, useTransition } from "react";
import { toast } from "sonner";

import { CustomizeSection, usePreview } from "@/components/customize-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { removeRedirect, saveRedirect } from "@/server/portal-settings";

type Redirect = { id: string; from: string; to: string };

/** Customize → Redirects (see the redirects.* operations): old addresses on the portal, and where they now go. */
export function RedirectsSettings({ projectSlug, redirects, max }: { projectSlug: string; redirects: Redirect[]; max: number }) {
  const preview = usePreview();
  const form = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveRedirect(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Redirect added");
      form.current?.reset();
      preview.reload();
    }
    return result;
  }, {});
  return (
    <>
      <CustomizeSection title="Add a redirect" description="Moving from another help center? Send its old addresses to the new ones, so links and search results keep working.">
        <form ref={form} {...keepingFields(action)}>
          <FieldGroup>
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor="redirect-from">Old address</FieldLabel>
              <Input id="redirect-from" name="from" required maxLength={2000} placeholder="/hc/en-us/articles/123-billing" autoComplete="off" />
              <FieldDescription>A path on your portal, or a whole address of your old site: its path is taken.</FieldDescription>
            </Field>
            <Field data-invalid={state.error ? true : undefined}>
              <FieldLabel htmlFor="redirect-to">New address</FieldLabel>
              <Input id="redirect-to" name="to" required maxLength={2000} placeholder="/docs/billing" autoComplete="off" />
              <FieldDescription>A path of your portal, or a full https:// address.</FieldDescription>
              {state.error && <FieldError>{state.error}</FieldError>}
            </Field>
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Adding…" : "Add redirect"}
            </Button>
          </FieldGroup>
        </form>
      </CustomizeSection>
      <CustomizeSection title="Redirects" description={`${redirects.length} of ${max}. Newest first.`}>
        {redirects.length === 0 ? (
          <EmptyState title="No redirects yet" description="Add one above for each old address people still use." />
        ) : (
          <ul aria-label="Redirects" className="flex flex-col divide-y">
            {redirects.map((redirect) => (
              <RedirectRow key={redirect.id} projectSlug={projectSlug} redirect={redirect} />
            ))}
          </ul>
        )}
      </CustomizeSection>
    </>
  );
}

function RedirectRow({ projectSlug, redirect }: { projectSlug: string; redirect: Redirect }) {
  const [pending, startTransition] = useTransition();
  const preview = usePreview();
  return (
    <li className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
      <span className="flex min-w-0 flex-1 flex-col text-sm">
        <code className="break-all">{redirect.from}</code>
        <span className="flex items-start gap-1 text-muted-foreground">
          <ArrowRightIcon aria-label="goes to" className="mt-0.5 size-3.5 shrink-0" />
          <code className="break-all">{redirect.to}</code>
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`Delete the redirect from ${redirect.from}`}
        onClick={() =>
          startTransition(async () => {
            const result = await removeRedirect(projectSlug, redirect.id);
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success("Redirect deleted");
              preview.reload();
            }
          })
        }
      >
        Delete
      </Button>
    </li>
  );
}
