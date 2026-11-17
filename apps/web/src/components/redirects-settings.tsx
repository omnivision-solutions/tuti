"use client";

import { ArrowRightIcon } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
import { EmptyState } from "@/components/empty-state";
import { SettingBlock, SettingsCard } from "@/components/settings-card";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { removeRedirect, saveRedirect } from "@/server/portal-settings";

type Redirect = { id: string; from: string; to: string };

/** Settings → Domain → Redirects (see the redirects.* operations): old addresses on the portal, and where they now go. */
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
      <SettingsCard title="Add a redirect" description="Moving from another help center? Send its old addresses to the new ones, so links and search results keep working.">
        <SettingBlock>
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
              <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled className="self-end">
                {pending ? "Adding…" : "Add redirect"}
              </Button>
            </FieldGroup>
          </form>
        </SettingBlock>
      </SettingsCard>
      <SettingsCard title="Redirects" description={`${redirects.length} of ${max}. Newest first.`}>
        <SettingBlock>
          {redirects.length === 0 ? (
            <EmptyState title="No redirects yet" description="Add one above for each old address people still use." />
          ) : (
            <ul aria-label="Redirects" className="flex flex-col divide-y">
              {redirects.map((redirect) => (
                <RedirectRow key={redirect.id} projectSlug={projectSlug} redirect={redirect} />
              ))}
            </ul>
          )}
        </SettingBlock>
      </SettingsCard>
    </>
  );
}

function RedirectRow({ projectSlug, redirect }: { projectSlug: string; redirect: Redirect }) {
  const [open, setOpen] = useState(false);
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
      <AlertDialog open={open} onOpenChange={(next) => (next || !pending) && setOpen(next)}>
        <Button variant="ghost" size="sm" disabled={pending} aria-label={`Delete the redirect from ${redirect.from}`} onClick={() => setOpen(true)}>
          Delete
        </Button>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this redirect?</AlertDialogTitle>
            <AlertDialogDescription>
              Visitors to <code className="break-all">{redirect.from}</code> will no longer be sent to <code className="break-all">{redirect.to}</code>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              focusableWhenDisabled
              onClick={() =>
                startTransition(async () => {
                  const result = await removeRedirect(projectSlug, redirect.id);
                  if (result.error) {
                    toast.error(result.error);
                    return;
                  }
                  setOpen(false);
                  toast.success("Redirect deleted");
                  preview.reload();
                })
              }
            >
              Delete redirect
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
