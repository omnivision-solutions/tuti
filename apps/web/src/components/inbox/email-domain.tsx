"use client";

import { ExternalLinkIcon } from "lucide-react";
import { Suspense, use, useActionState, useState, useTransition } from "react";
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
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SettingBlock, SettingRow } from "@/components/settings-card";
import { timeAgo } from "@/lib/format";
import { keepingFields } from "@/lib/forms";
import { EMAIL_FORWARDING_DOCS, type MailProvider } from "@/lib/mail-providers";
import type { OneClickDns } from "@/server/domain-connect";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
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

const LABEL = "Send from your own address";
const INFO = "Use your company's address, like support@yourcompany.com, instead of your support address: replies come from it, and emails to it land in the Inbox.";

/** The row's line: the address replies come from now, broken anywhere where the row has no room for it (beside a status, on phones). */
const repliesFrom = (address: string) => (
  <>
    Replies come from <span className="break-all">{address}</span>.
  </>
);

/** Where the own address stands, in a word or two, on its row: sending first (its DNS records, the plan), then receiving. */
function ownStatus(own: OwnDomain): { label: string; variant: "soft" | "outline" | "destructive" } {
  if (own.error) {
    return { label: "Not verified", variant: "destructive" };
  }
  if (!own.verified) {
    return { label: "Waiting for DNS", variant: "outline" };
  }
  if (!own.included) {
    return { label: "Not on your plan", variant: "outline" };
  }
  return own.receivedAt ? { label: "Working", variant: "soft" } : { label: "No email received yet", variant: "outline" };
}

/**
 * Settings → Inbox and email → Send from your own address (support.setEmailDomain): the team's own address, both
 * ways. One row with "Set up" until there's an address; its steps show once started, and stay while one is set, the
 * row saying where it stands.
 * In steps: the address, then sending emails: they put the 3 CNAMEs it shows in their DNS (each part
 * selectable, with Copy) and check; once
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
  upgrade,
}: {
  projectSlug: string;
  own: OwnDomain;
  supportAddress: string;
  /** Where the domain's DNS provider can add the records itself, while they're needed. */
  oneClick?: Promise<OneClickDns | null> | null;
  /** Who receives the domain's email (lib/mail-providers.ts), while it isn't forwarded yet. */
  receiver?: Promise<Receiver> | null;
  /** Where the project's plan doesn't include it: what "Set up" says instead of starting (docs/design.md, Interaction). */
  upgrade?: UpgradePrompt | null;
}) {
  if (!own.address) {
    // Its own component: "Set up" starts closed again once an address is removed.
    return <SetUp projectSlug={projectSlug} supportAddress={supportAddress} upgrade={upgrade} />;
  }
  const sending = own.verified && own.included;
  // SES checks the 3 together. A failure isn't always theirs (SES may have lost the domain): it says
  // why above them, and they get no status.
  const status: DnsStatus | undefined = own.verified ? "verified" : own.error ? undefined : "pending";
  const stands = ownStatus(own);
  return (
    <>
      <SettingRow label={LABEL} description={repliesFrom(sending ? own.address : supportAddress)} info={INFO} inline>
        <Badge variant={stands.variant}>{stands.label}</Badge>
      </SettingRow>
      <SettingBlock className="gap-6">
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
            status={<Badge variant={own.verified ? "soft" : own.error ? "destructive" : "outline"}>{own.verified ? "Verified" : own.error ? "Not verified" : "Waiting for DNS"}</Badge>}
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
            status={<Badge variant={own.receivedAt ? "soft" : "outline"}>{own.receivedAt ? "Forwarded" : "Waiting for an email"}</Badge>}
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
      </SettingBlock>
    </>
  );
}

/**
 * No address yet: the row with "Set up", which shows the steps (the address first) under it. On a plan without it the
 * row looks the same, and "Set up" opens the upgrade prompt.
 */
function SetUp({ projectSlug, supportAddress, upgrade }: { projectSlug: string; supportAddress: string; upgrade?: UpgradePrompt | null }) {
  const [started, setStarted] = useState(false);
  const open = started && !upgrade;
  return (
    <>
      <SettingRow label={LABEL} description={repliesFrom(supportAddress)} info={INFO} inline>
        {upgrade && (
          <span id="email-domain-plan" hidden>
            {upgrade.title}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          {...(upgrade ? { "aria-describedby": "email-domain-plan", "aria-haspopup": "dialog" } : { "aria-expanded": open, "aria-controls": "email-domain-setup" })}
          onClick={() => setStarted(!started)}
        >
          {open ? "Cancel" : "Set up"}
        </Button>
        {upgrade && <UpgradeDialog prompt={upgrade} open={started} onOpenChange={setStarted} />}
      </SettingRow>
      {open && (
        <SettingBlock>
          <div id="email-domain-setup">
            <SetupSteps>
              <SetupStep title="Your address" state="current" description="Your company's address. Your users' replies to it still land in the Inbox.">
                <AddAddressForm projectSlug={projectSlug} />
              </SetupStep>
              <SetupStep title="Sending emails" state="upcoming" description="Replies to your users come from it once 3 DNS records are in." />
              <SetupStep title="Receiving emails" state="upcoming" description="Forward it to your support address, so emails to it land in the Inbox." />
            </SetupSteps>
          </div>
        </SettingBlock>
      )}
    </>
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
        <Input id="email-domain-address" name="address" autoFocus type="email" required maxLength={254} placeholder="support@yourcompany.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
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
      <AlertDialogContent closeDisabled={pending}>
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
