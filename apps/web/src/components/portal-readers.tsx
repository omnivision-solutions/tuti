"use client";

import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { ItemList, ItemRow } from "@/components/item-list";
import { SettingsCard } from "@/components/settings-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { timeAgo } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { errorMessage, useTRPCClient } from "@/components/trpc";

type Reader = { email: string; addedAt: string; addedBy: string | null };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings → Access, on a private portal: the people who may read it by email, besides the
 * team and SSO users, as the page's second card. Adding them (in a dialog) emails each a link
 * to the portal (when email is set up).
 */
export function PortalReaders({ projectSlug, readers }: { projectSlug: string; readers: Reader[] }) {
  const [adding, setAdding] = useState(false);
  // While the dialog is adding it stays open (Escape, a click outside, ×), so a refusal isn't lost with it. A ref: state
  // set inside the form's action would only show once the action is over.
  const busy = useRef(false);
  return (
    <SettingsCard
      title="Readers"
      count={readers.length}
      action={
        <Dialog open={adding} onOpenChange={(next) => (next || !busy.current) && setAdding(next)}>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>
            <PlusIcon aria-hidden />
            Add readers
          </DialogTrigger>
          {/* A long list pasted on a phone scrolls in the dialog: its buttons stay on the screen. */}
          <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto">
            {/* Inside the content, which is there only while it's open: each opening starts empty, with no error left. */}
            <AddReadersForm projectSlug={projectSlug} onBusy={(adding) => { busy.current = adding; }} onAdded={() => setAdding(false)} />
          </DialogContent>
        </Dialog>
      }
    >
      {readers.length > 0 ? (
        <ItemList aria-label="Readers">
          {readers.map((reader) => (
            <ItemRow
              key={reader.email}
              className="px-4 py-3 first:pt-3 last:pb-3 @min-[34rem]/settings:px-5"
              title={<span className="break-all">{reader.email}</span>}
              meta={`${reader.email.startsWith("@") ? `Everyone with a verified ${reader.email} address · ` : ""}Added ${timeAgo(new Date(reader.addedAt))}${reader.addedBy ? ` by ${reader.addedBy}` : ""}`}
              actions={<ReaderActions projectSlug={projectSlug} email={reader.email} />}
            />
          ))}
        </ItemList>
      ) : (
        <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No readers yet.</p>
      )}
    </SettingsCard>
  );
}

function AddReadersForm({ projectSlug, onBusy, onAdded }: { projectSlug: string; onBusy: (adding: boolean) => void; onAdded: () => void }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  const [state, action, pending] = useActionState(async (_prev: { error?: string }, formData: FormData) => {
    onBusy(true);
    // The addresses and domains, separated by commas, spaces or lines.
    const emails = String(formData.get("emails") ?? "")
      .split(/[\s,;]+/)
      .filter(Boolean);
    const result: { error?: string; added?: string[]; emailed?: number } = await trpc.portalReaders.add
      .mutate({ project: projectSlug, emails })
      .catch((error: unknown) => ({ error: errorMessage(error) }))
      .finally(() => onBusy(false));
    if (!result.error) {
      const added = result.added ?? [];
      const people = added.filter((entry) => !entry.startsWith("@")).length;
      const emailed = result.emailed ?? 0;
      const what = added.length === 1 && people === 0 ? `${added[0]} added` : `${plural(added.length, "reader")} added`;
      toast.success(
        added.length === 0
          ? "They're already readers"
          : emailed > 0 && emailed === people && people === added.length
            ? `${what}; we emailed them a link`
            : emailed > 0
              ? `${what}; we emailed ${emailed} of them`
              : what,
      );
      onAdded();
      // The list is the page's.
      router.refresh();
    }
    return result.error ? { error: result.error } : {};
  }, {});

  return (
    <form {...keepingFields(action)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Add readers</DialogTitle>
        <DialogDescription>
          People outside your team who may read the portal, or a whole domain like @acme.com for everyone there. They sign in
          with their address: an emailed sign-in link works even without an account.
        </DialogDescription>
      </DialogHeader>
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="portal-reader-emails">Email addresses or domains</FieldLabel>
        <Textarea
          id="portal-reader-emails"
          name="emails"
          rows={3}
          required
          placeholder="ada@example.com, @acme.com"
          aria-invalid={state.error ? true : undefined}
        />
        <FieldDescription>Up to 20 at once, separated by commas or lines.</FieldDescription>
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" disabled={pending} focusableWhenDisabled>
          Add readers
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A reader's ⋯ menu: Remove, which asks first. */
function ReaderActions({ projectSlug, email }: { projectSlug: string; email: string }) {
  const [pending, startTransition] = useTransition();
  const trpc = useTRPCClient();
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${email}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={removing} onOpenChange={(next) => (next || !pending) && setRemoving(next)}>
        <AlertDialogContent closeDisabled={pending}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-all">Remove {email}?</AlertDialogTitle>
            <AlertDialogDescription>They can&apos;t read the portal until you add them again. Their account stays.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              focusableWhenDisabled
              onClick={() =>
                startTransition(async () => {
                  try {
                    await trpc.portalReaders.remove.mutate({ project: projectSlug, email });
                  } catch (error) {
                    toast.error(errorMessage(error));
                    return;
                  }
                  toast.success(`${email} removed`);
                  // The list is the page's.
                  router.refresh();
                })
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
