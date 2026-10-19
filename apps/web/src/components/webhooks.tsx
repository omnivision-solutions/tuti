"use client";

import { CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/empty-state";
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
import { Input } from "@/components/ui/input";
import { type DeliverySummary, lastDeliveryText, WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhook-events";
import { createWebhook, deleteWebhook, sendTestWebhook } from "@/server/webhooks";

export type WebhookView = {
  id: string;
  url: string;
  events: string[];
  lastDelivery: DeliverySummary | null;
};


export function Webhooks({ projectSlug, webhooks }: { projectSlug: string; webhooks: WebhookView[] }) {
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-4">
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
        <div className="flex flex-wrap items-center gap-2">
          <Input
            name="url"
            type="url"
            required
            placeholder="https://example.com/tuti-webhook"
            aria-label="Endpoint URL"
            className="min-w-0 flex-1 sm:max-w-md"
          />
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add webhook"}
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <legend className="sr-only">Events to send</legend>
          {(Object.keys(WEBHOOK_EVENTS) as WebhookEvent[]).map((event) => (
            <label key={event} className="flex items-center gap-2">
              <input type="checkbox" name="events" value={event} defaultChecked className="size-4 accent-primary" />
              {WEBHOOK_EVENTS[event]} <code className="font-mono text-xs text-muted-foreground">{event}</code>
            </label>
          ))}
        </fieldset>
      </form>

      {secret && (
        <Alert>
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
              <a href="/docs/api#webhooks" className="underline underline-offset-4">
                how
              </a>
              ).
            </span>
          </AlertDescription>
        </Alert>
      )}

      {webhooks.length === 0 ? (
        <EmptyState title="No webhooks yet" description="Add an endpoint to hear about new posts, comments and status changes." />
      ) : (
        <ItemList>
          {webhooks.map((webhook) => (
            <ItemRow
              key={webhook.id}
              title={<span className="break-all">{webhook.url}</span>}
              meta={[
                webhook.events.map((e) => WEBHOOK_EVENTS[e as WebhookEvent] ?? e).join(", "),
                lastDeliveryText(webhook.lastDelivery),
              ].join(" · ")}
              actions={<WebhookActions projectSlug={projectSlug} webhook={webhook} />}
            />
          ))}
        </ItemList>
      )}
    </div>
  );
}

function WebhookActions({ projectSlug, webhook }: { projectSlug: string; webhook: WebhookView }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
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
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Delete
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this webhook?</AlertDialogTitle>
            <AlertDialogDescription>
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
