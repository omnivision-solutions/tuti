"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useActionState, useTransition } from "react";
import { toast } from "sonner";

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
import { CopyField } from "@/components/copy-button";
import { OneClickDnsButton } from "@/components/one-click-dns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { EMAIL_FORWARDING_DOCS, type MailProvider } from "@/lib/mail-providers";
import type { OneClickDns } from "@/server/domain-connect";
import type { FormState } from "@/server/form-state";
import { checkEmailDomain, forgetEmailDomain, saveEmailDomain, sendEmailDomainTest } from "@/server/inbox";

type OwnDomain = {
  /** On the project's plan: once downgraded, a verified address waits, and replies come from the support address. */
  included: boolean;
  address: string | null;
  records: { type: "CNAME"; name: string; value: string }[];
  verified: boolean;
  error: string | null;
  /** When an email forwarded from the address last came. */
  receivedAt: Date | null;
};

/**
 * Settings → Support → Your own address (support.setEmailDomain): the team's own address, both ways.
 * Sending emails: they put the 3 CNAMEs it shows in their DNS (each with Copy) and check; once
 * verified, replies come from it, and a test email shows it working. Receiving emails: they forward
 * it to the support address at their email provider (its guide, from the domain's MX); the first
 * email forwarded from it shows that works.
 */
export function EmailDomainSettings({
  projectSlug,
  own,
  supportAddress,
  oneClick,
  receiver = "other",
}: {
  projectSlug: string;
  own: OwnDomain;
  supportAddress: string;
  /** Where the domain's DNS provider can add the records itself, while they're needed. */
  oneClick?: Promise<OneClickDns | null> | null;
  /** Who receives the domain's email (lib/mail-providers.ts), while it isn't forwarded yet. */
  receiver?: MailProvider | "none" | "other";
}) {
  if (!own.address) {
    return <AddAddressForm projectSlug={projectSlug} />;
  }
  const sending = own.verified && own.included;
  const domain = own.address.slice(own.address.lastIndexOf("@") + 1);
  return (
    <div className="flex flex-col gap-6">
      <span className="font-medium break-all">{own.address}</span>
      <section aria-label="Sending emails" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Sending emails</h3>
          <Badge variant={own.verified ? "default" : own.error ? "destructive" : "secondary"}>{own.verified ? "Verified" : own.error ? "Not verified" : "Waiting for DNS"}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {sending
            ? `Replies to your users come from ${own.address}. Keep these records at your DNS provider:`
            : !own.included
              ? `Your plan doesn't include sending from your own address any more: replies come from ${supportAddress} until it does.`
              : own.error
              ? `${own.error}. Replies come from ${supportAddress} until it's verified again.`
              : `Add these 3 records at your domain's DNS provider, then check. Until then, replies come from ${supportAddress}.`}
        </p>
        <OneClickDnsButton link={oneClick} />
        {own.records.map((record, i) => (
          <section key={record.name} aria-label={`CNAME record ${i + 1}`} className="flex flex-col gap-2">
            <CopyField label="Host" name={`CNAME ${i + 1} host`} value={record.name} />
            <CopyField label="Target" name={`CNAME ${i + 1} target`} value={record.value} />
          </section>
        ))}
        <div className="flex flex-wrap justify-end gap-2">
          {sending ? <TestButton projectSlug={projectSlug} /> : !own.verified && <CheckButton projectSlug={projectSlug} address={own.address} />}
        </div>
      </section>
      <section aria-label="Receiving emails" className="flex flex-col gap-4 border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Receiving emails</h3>
          <Badge variant={own.receivedAt ? "default" : "secondary"}>{own.receivedAt ? "Forwarded" : "Waiting for an email"}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {own.receivedAt
            ? `Emails to ${own.address} land in the Inbox. Keep forwarding it:`
            : receiver === "none"
              ? `Nothing receives email for ${domain} yet. Set up a forwarding service for it (Cloudflare Email Routing and ImprovMX are free), and forward ${own.address}:`
              : `${typeof receiver === "object" ? `${domain}'s email is at ${receiver.name}. There` : "At your email provider"}, forward ${own.address} to your support address, so emails to it land in the Inbox:`}
        </p>
        <section aria-label={`Forward ${own.address}`} className="flex flex-col gap-2">
          <CopyField label="From" name="forwarding from" value={own.address} />
          <CopyField label="To" name="forwarding to" value={supportAddress} />
        </section>
        {!own.receivedAt && (
          <>
            <a
              href={typeof receiver === "object" ? receiver.docs : EMAIL_FORWARDING_DOCS}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 self-start text-sm underline underline-offset-4"
            >
              {typeof receiver === "object" ? `How to forward with ${receiver.name}` : "How to forward it"}
              <ExternalLinkIcon className="size-3.5" />
            </a>
            <p className="text-sm text-muted-foreground">
              Your provider may ask to confirm the forwarding: that email lands in the Inbox. Then send an email to {own.address} to check: it shows here once it
              arrives.
            </p>
          </>
        )}
        {own.receivedAt && <p className="text-sm text-muted-foreground">Last email received {timeAgo(new Date(own.receivedAt))}.</p>}
      </section>
      <div className="flex flex-wrap justify-end gap-2 border-t pt-6">
        <RemoveButton projectSlug={projectSlug} address={own.address} supportAddress={supportAddress} />
      </div>
    </div>
  );
}

function AddAddressForm({ projectSlug }: { projectSlug: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveEmailDomain(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3">
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="email-domain-address">Your company&apos;s address</FieldLabel>
        <Input id="email-domain-address" name="address" type="email" required maxLength={254} placeholder="support@yourcompany.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        <FieldDescription>Replies to your users come from it once its domain is verified. Their replies still land in the Inbox.</FieldDescription>
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Adding…" : "Use this address"}
      </Button>
    </form>
  );
}

function CheckButton({ projectSlug, address }: { projectSlug: string; address: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await checkEmailDomain(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else if (result.verified) {
            toast.success(`${address} is verified`);
          } else {
            toast.info("Not found yet: DNS changes can take a while to show. We check again daily.");
          }
        })
      }
    >
      {pending ? "Checking…" : "Check DNS"}
    </Button>
  );
}

function TestButton({ projectSlug }: { projectSlug: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await sendEmailDomainTest(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success("Test email sent to you");
          }
        })
      }
    >
      {pending ? "Sending…" : "Send a test email"}
    </Button>
  );
}

function RemoveButton({ projectSlug, address, supportAddress }: { projectSlug: string; address: string; supportAddress: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>Remove address</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Stop sending from {address}?</AlertDialogTitle>
          <AlertDialogDescription>
            Replies come from {supportAddress} again. You can remove the 3 records from your DNS; keep forwarding the address if its emails should still land in
            the Inbox.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await forgetEmailDomain(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${address} removed`);
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
