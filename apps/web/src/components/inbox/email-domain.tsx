"use client";

import { ExternalLinkIcon } from "lucide-react";
import { Suspense, use, useActionState, useTransition } from "react";
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
import { CopyRows, type DnsStatus, DnsRecords, SetupStep, SetupSteps, SetupValue, WaitingNotice } from "@/components/dns-setup";
import { OneClickDnsButton } from "@/components/one-click-dns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
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
 * In steps: the address, then sending emails: they put the 3 CNAMEs it shows in their DNS (a click
 * copies each part) and check; once
 * verified, replies come from it, and a test email shows it working. Receiving emails: they forward
 * it to the support address at their email provider (its guide, from the domain's MX); the first
 * email forwarded from it shows that works.
 */
export function EmailDomainSettings({
  projectSlug,
  own,
  supportAddress,
  oneClick,
  receiver,
}: {
  projectSlug: string;
  own: OwnDomain;
  supportAddress: string;
  /** Where the domain's DNS provider can add the records itself, while they're needed. */
  oneClick?: Promise<OneClickDns | null> | null;
  /** Who receives the domain's email (lib/mail-providers.ts), while it isn't forwarded yet. */
  receiver?: Promise<Receiver> | null;
}) {
  if (!own.address) {
    return (
      <SetupSteps>
        <SetupStep title="Your address" state="current" description="Your company's address. Your users' replies to it still land in the Inbox.">
          <AddAddressForm projectSlug={projectSlug} />
        </SetupStep>
        <SetupStep title="Sending emails" state="upcoming" description="Replies to your users come from it once 3 DNS records are in." />
        <SetupStep title="Receiving emails" state="upcoming" description="Forward it to your support address, so emails to it land in the Inbox." />
      </SetupSteps>
    );
  }
  const sending = own.verified && own.included;
  // SES checks the 3 together. A failure isn't always theirs (SES may have lost the domain): it says
  // why above them, and they get no status.
  const status: DnsStatus | undefined = own.verified ? "verified" : own.error ? undefined : "pending";
  return (
    <div className="flex flex-col gap-6">
      <SetupSteps>
        <SetupStep title="Your address" state="done">
          <SetupValue>{own.address}</SetupValue>
        </SetupStep>
        <SetupStep
          title="Sending emails"
          state={sending ? "done" : "current"}
          description={
            sending
              ? `Replies to your users come from ${own.address}. Keep these records at your DNS provider.`
              : !own.included
                ? `Your plan doesn't include sending from your own address any more: replies come from ${supportAddress} until it does.`
                : own.error
                  ? `${own.error}. Replies come from ${supportAddress} until it's verified again.`
                  : `Add these 3 records at your domain's DNS provider, then check. Until then, replies come from ${supportAddress}.`
          }
          status={<Badge variant={own.verified ? "default" : own.error ? "destructive" : "secondary"}>{own.verified ? "Verified" : own.error ? "Not verified" : "Waiting for DNS"}</Badge>}
          aside={!own.verified && <OneClickDnsButton link={oneClick} />}
        >
          {!own.verified && !own.error && own.included && (
            <WaitingNotice>Waiting for your DNS records. Changes can take a while to show; we check again daily.</WaitingNotice>
          )}
          <DnsRecords records={own.records.map((record) => ({ ...record, status }))} label={`DNS records for ${own.address.slice(own.address.lastIndexOf("@") + 1)}`} />
          <div>{sending ? <TestButton projectSlug={projectSlug} /> : !own.verified && <CheckButton projectSlug={projectSlug} address={own.address} />}</div>
        </SetupStep>
        <SetupStep
          title="Receiving emails"
          state={own.receivedAt ? "done" : "current"}
          description={
            own.receivedAt ? (
              `Emails to ${own.address} land in the Inbox. Keep forwarding it. Last email received ${timeAgo(new Date(own.receivedAt))}.`
            ) : (
              <Suspense fallback={<ForwardingGuide address={own.address} receiver="other" />}>
                <DetectedGuide address={own.address} receiver={receiver} />
              </Suspense>
            )
          }
          status={<Badge variant={own.receivedAt ? "default" : "secondary"}>{own.receivedAt ? "Forwarded" : "Waiting for an email"}</Badge>}
        >
          <CopyRows
            label={`Forward ${own.address}`}
            rows={[
              { label: "From", value: own.address, name: "forwarding from" },
              { label: "To", value: supportAddress, name: "forwarding to" },
            ]}
          />
          {!own.receivedAt && (
            <p className="text-sm text-muted-foreground">
              Your provider may ask to confirm the forwarding: that email lands in the Inbox. Then send an email to {own.address} to check: it shows here once it
              arrives.
            </p>
          )}
        </SetupStep>
      </SetupSteps>
      <div className="flex justify-end border-t pt-4">
        <RemoveButton projectSlug={projectSlug} address={own.address} supportAddress={supportAddress} />
      </div>
    </div>
  );
}

type Receiver = MailProvider | "none" | "other";

function DetectedGuide({ address, receiver }: { address: string; receiver?: Promise<Receiver> | null }) {
  return <ForwardingGuide address={address} receiver={receiver ? use(receiver) : "other"} />;
}

/** How to forward the address: where its domain's email is (from its MX), and that provider's guide. */
function ForwardingGuide({ address, receiver }: { address: string; receiver: Receiver }) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return (
    <div className="flex flex-col gap-2">
      <p>
        {receiver === "none"
          ? `Nothing receives email for ${domain} yet. Set up a forwarding service for it (Cloudflare Email Routing and ImprovMX are free), and forward ${address}:`
          : `${typeof receiver === "object" ? `${domain}'s email is at ${receiver.name}. There` : "At your email provider"}, forward ${address} to your support address, so emails to it land in the Inbox:`}
      </p>
      <a
        href={typeof receiver === "object" ? receiver.docs : EMAIL_FORWARDING_DOCS}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 self-start font-medium text-foreground underline underline-offset-4"
      >
        {typeof receiver === "object" ? `How to forward with ${receiver.name}` : "How to forward it"}
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </div>
  );
}

function AddAddressForm({ projectSlug }: { projectSlug: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveEmailDomain(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Field data-invalid={state.error ? true : undefined} className="flex-1">
        <FieldLabel htmlFor="email-domain-address" className="sr-only">
          Your company&apos;s address
        </FieldLabel>
        <Input id="email-domain-address" name="address" type="email" required maxLength={254} placeholder="support@yourcompany.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
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
