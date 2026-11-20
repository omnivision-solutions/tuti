"use client";

import { CheckIcon, CopyIcon, MoreHorizontalIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ItemList, ItemRow } from "@/components/item-list";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { type DeliverySummary, lastDeliveryText, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhook-events";
import { createWebhook, deleteWebhook, sendTestWebhook } from "@/server/webhooks";

export type WebhookView = {
  id: string;
  url: string;
  events: string[];
  lastDelivery: DeliverySummary | null;
};

/**
 * Developers' "Add webhook": the endpoint and the events to send it, in a dialog. It stays open on the new webhook's
 * signing secret, which is shown once; closed and opened again, it's empty.
 */
export function AddWebhookDialog({ projectSlug }: { projectSlug: string }) {
  const [open, setOpen] = useState(false);
  const transition = useTransition();
  return (
    // A tap beside it doesn't close it, and nothing does while the webhook is being added: the secret it shows isn't shown again.
    <Dialog disablePointerDismissal open={open} onOpenChange={(next) => (next || !transition[0]) && setOpen(next)}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <PlusIcon />
        Add webhook
      </DialogTrigger>
      <DialogContent initialFocus={() => document.getElementById("webhook-url")} className="max-h-[calc(100dvh-2rem)] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a webhook</DialogTitle>
          <DialogDescription>Tuti sends a signed POST to your endpoint when something happens, and retries for about a day until it answers with a 2xx.</DialogDescription>
        </DialogHeader>
        <AddWebhookForm projectSlug={projectSlug} transition={transition} />
      </DialogContent>
    </Dialog>
  );
}

function AddWebhookForm({ projectSlug, transition: [pending, startTransition] }: { projectSlug: string; transition: ReturnType<typeof useTransition> }) {
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          startTransition(async () => {
            const result = await createWebhook(projectSlug, String(data.get("url")), data.getAll("events").map(String));
            if (result.error || !result.secret) {
              toast.error(result.error ?? "Couldn't add the webhook");
              return;
            }
            setSecret(result.secret);
            setCopied(false);
            form.reset();
          });
        }}
      >
        <Input id="webhook-url" name="url" type="url" required placeholder="https://example.com/tuti-webhook" aria-label="Endpoint URL" />
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="sr-only">Events to send</legend>
          {(Object.keys(WEBHOOK_EVENTS) as WebhookEvent[]).map((event) => (
            <label key={event} className="flex flex-wrap items-center gap-x-2">
              <input type="checkbox" name="events" value={event} defaultChecked className="size-4 accent-primary" />
              {WEBHOOK_EVENTS[event]} <code className="font-mono text-xs text-muted-foreground">{event}</code>
            </label>
          ))}
        </fieldset>
        <Button type="submit" disabled={pending} focusableWhenDisabled>
          {pending ? "Adding…" : "Add webhook"}
        </Button>
      </form>

      {secret && (
        <Alert className="grid-cols-[auto_minmax(0,1fr)]">
          <TriangleAlertIcon />
          <AlertTitle>Copy the signing secret now. It won&apos;t be shown again.</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <div className="flex w-full items-center gap-2">
              <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">
                {secret}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(secret);
                  setCopied(true);
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? "Copied" : "Copy secret"}
              </Button>
            </div>
            <span>
              Check the Tuti-Signature header of every request with it (
              <a href="/api/docs#webhooks" className="underline underline-offset-4">
                how
              </a>
              ).
            </span>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Developers' webhooks: each endpoint with its events and its last delivery; Send test and Delete under the row's ⋯. */
export function Webhooks({ projectSlug, webhooks }: { projectSlug: string; webhooks: WebhookView[] }) {
  if (webhooks.length === 0) {
    return <p className="px-4 py-3.5 text-sm text-muted-foreground @min-[34rem]/settings:px-5">No webhooks yet. Tuti POSTs to your endpoint as things happen.</p>;
  }
  return (
    <ItemList aria-label="Webhooks">
      {webhooks.map((webhook) => (
        <ItemRow
          key={webhook.id}
          className="px-4 py-3.5 first:pt-3.5 last:pb-3.5 @min-[34rem]/settings:px-5"
          title={<span className="break-all">{webhook.url}</span>}
          meta={[
            webhook.events.map((e) => WEBHOOK_EVENTS[e as WebhookEvent] ?? e).join(", "),
            lastDeliveryText(webhook.lastDelivery),
          ].join(" · ")}
          actions={<WebhookActions projectSlug={projectSlug} webhook={webhook} />}
        />
      ))}
    </ItemList>
  );
}

function WebhookActions({ projectSlug, webhook }: { projectSlug: string; webhook: WebhookView }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} focusableWhenDisabled aria-label={`Actions for ${webhook.url}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-32">
          <DropdownMenuItem
            onClick={() =>
              startTransition(async () => {
                const result = await sendTestWebhook(projectSlug, webhook.id);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success("Test event sent");
                }
              })
            }
          >
            Send test
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setOpen(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this webhook?</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              {webhook.url} stops getting events right away, including retries that are still waiting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteWebhook(projectSlug, webhook.id);
                  if (result.error) {
                    toast.error(result.error);
                    return;
                  }
                  setOpen(false);
                  toast.success("Webhook deleted");
                })
              }
            >
              Delete webhook
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
