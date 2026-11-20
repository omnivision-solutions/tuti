"use client";

import { ArrowRightIcon, MoreHorizontalIcon } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { usePreview } from "@/components/customize-shell";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { removeRedirect, saveRedirect } from "@/server/portal-settings";

type Redirect = { id: string; from: string; to: string };

const OLD_ADDRESS = "redirect-from";

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
  // One deleted: its row, and the ⋯ menu that had focus, is gone. Focus goes to the form's first field.
  const count = useRef(redirects.length);
  useEffect(() => {
    if (redirects.length < count.current) {
      document.getElementById(OLD_ADDRESS)?.focus();
    }
    count.current = redirects.length;
  }, [redirects.length]);
  return (
    <SettingsCard
      title={
        <>
          Redirects{" "}
          <span className="font-normal text-muted-foreground">
            {redirects.length} of {max}
          </span>
        </>
      }
    >
      <SettingBlock className="gap-2">
        {/* One line: old → new → Add. One under another where the card is a phone's width. */}
        <form ref={form} {...keepingFields(action)} className="flex flex-col gap-2 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center">
          <label htmlFor={OLD_ADDRESS} className="sr-only">
            Old address
          </label>
          <Input
            id={OLD_ADDRESS}
            name="from"
            required
            maxLength={2000}
            placeholder="Old address: /hc/en-us/articles/123-billing"
            title="A path on your portal, or a whole address of your old site: its path is taken."
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "redirect-error" : undefined}
            className="min-w-0 @min-[34rem]/settings:flex-1"
          />
          <ArrowRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground @max-[34rem]/settings:hidden" />
          <label htmlFor="redirect-to" className="sr-only">
            New address
          </label>
          <Input
            id="redirect-to"
            name="to"
            required
            maxLength={2000}
            placeholder="New address: /docs/billing"
            title="A path of your portal, or a full https:// address."
            autoComplete="off"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "redirect-error" : undefined}
            className="min-w-0 @min-[34rem]/settings:flex-1"
          />
          <Button type="submit" variant="outline" disabled={pending} focusableWhenDisabled aria-label={pending ? undefined : "Add redirect"}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </form>
        {state.error && <FieldError id="redirect-error">{state.error}</FieldError>}
      </SettingBlock>
      {redirects.length === 0 ? (
        <SettingBlock>
          <p className="text-sm text-muted-foreground">No redirects yet. Send your old help center&apos;s addresses to the new ones, so links and search results keep working.</p>
        </SettingBlock>
      ) : (
        <ul aria-label="Redirects" className="flex flex-col divide-y">
          {redirects.map((redirect) => (
            <RedirectRow key={redirect.id} projectSlug={projectSlug} redirect={redirect} />
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}

/** A redirect's ⋯ menu: Delete, which asks first. */
function RedirectRow({ projectSlug, redirect }: { projectSlug: string; redirect: Redirect }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const preview = usePreview();
  return (
    <li className="flex items-center gap-2 px-4 py-2.5 @min-[34rem]/settings:px-5">
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 font-mono text-xs leading-5">
        <code className="break-all">{redirect.from}</code>
        <span className="flex min-w-0 items-start gap-2 text-muted-foreground">
          <ArrowRightIcon aria-label="goes to" className="mt-1 size-3.5 shrink-0" />
          <code className="break-all">{redirect.to}</code>
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for the redirect from ${redirect.from}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-32">
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={(next) => (next || !pending) && setOpen(next)}>
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
