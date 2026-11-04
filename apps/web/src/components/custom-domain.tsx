"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useRef, useTransition } from "react";
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
import { type DnsStatus, DnsRecords, SetupStep, SetupSteps, SetupValue, WaitingNotice } from "@/components/dns-setup";
import { OneClickDnsButton } from "@/components/one-click-dns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { OneClickDns } from "@/server/domain-connect";
import { removeCustomDomain, saveCustomDomain, verifyCustomDomain } from "@/server/portal-settings";
import type { FormState } from "@/server/form-state";

type Domain = {
  hostname: string;
  status: "pending" | "verified";
  /** Where Cloudflare gets the domain's certificate: its status; null where the server's proxy does. */
  certificate: "pending" | "active" | "failed" | null;
  records: { type: "CNAME" | "TXT"; name: string; value: string }[];
};

/**
 * Settings → Domain → Custom domain (see the domain.* operations): the portal at a domain of the
 * team's own, in three steps. They connect it, add the DNS records it shows (each part selectable, with Copy)
 * and check; once verified (and its certificate's in) the portal answers there.
 */
export function CustomDomainSettings({
  projectSlug,
  domain,
  portalAddress,
  protocol,
  oneClick,
}: {
  projectSlug: string;
  domain: Domain | null;
  portalAddress: string;
  protocol: string;
  /** Where the domain's DNS provider can add the records itself, while they're needed. */
  oneClick?: Promise<OneClickDns | null> | null;
}) {
  if (!domain) {
    return (
      <SetupSteps>
        <SetupStep title="Domain" state="current" description={`A subdomain of a domain you own. Your portal stays at ${portalAddress} too.`}>
          <AddDomainForm projectSlug={projectSlug} />
        </SetupStep>
        <SetupStep title="DNS records" state="upcoming" description="Add its records at your domain's DNS provider." />
        <SetupStep title="Live" state="upcoming" description="Your portal answers at your domain." />
      </SetupSteps>
    );
  }
  const verified = domain.status === "verified";
  const live = verified && domain.certificate !== "pending" && domain.certificate !== "failed";
  const target = domain.records.find((record) => record.type === "CNAME")?.value;
  // The TXT record is what Check DNS looks for. Nothing checks the CNAME but Cloudflare, as it gets
  // the domain's certificate once it's verified: no status before then, or where Cloudflare isn't used.
  const statuses: Record<Domain["records"][number]["type"], DnsStatus | undefined> = {
    TXT: verified ? "verified" : "pending",
    CNAME: domain.certificate === "active" ? "verified" : (domain.certificate ?? undefined),
  };
  const badge = !verified
    ? { label: "Waiting for DNS", variant: "outline" as const }
    : domain.certificate === "pending"
      ? { label: "Certificate pending", variant: "outline" as const }
      : domain.certificate === "failed"
        ? { label: "Certificate failed", variant: "destructive" as const }
        : { label: "Verified", variant: "soft" as const };
  return (
    <div className="flex flex-col gap-6">
      <SetupSteps>
        <SetupStep title="Domain" state="done" status={<Badge variant={badge.variant}>{badge.label}</Badge>}>
          <SetupValue>{domain.hostname}</SetupValue>
        </SetupStep>
        <SetupStep
          title="DNS records"
          state={verified ? "done" : "current"}
          description={verified ? "Keep these records at your DNS provider." : "Add these records at your domain's DNS provider, then check."}
          aside={!verified && <OneClickDnsButton link={oneClick} />}
        >
          {!verified && <WaitingNotice>Waiting for your DNS records. Changes can take a few minutes to show.</WaitingNotice>}
          <DnsRecords records={domain.records.map((record) => ({ ...record, status: statuses[record.type] }))} label={`DNS records for ${domain.hostname}`} />
          {!verified && (
            <div>
              <CheckDnsButton projectSlug={projectSlug} hostname={domain.hostname} />
            </div>
          )}
        </SetupStep>
        <SetupStep
          title="Live"
          state={live ? "done" : verified ? "current" : "upcoming"}
          description={
            !verified ? (
              `Your portal answers at ${domain.hostname} once its records are in.`
            ) : domain.certificate === "pending" ? (
              `Verified. Your portal's HTTPS certificate there is on its way: it takes a few minutes once ${domain.hostname} points at ${target}. Check again in a moment.`
            ) : domain.certificate === "failed" ? (
              `We couldn't get an HTTPS certificate for ${domain.hostname}. Check that its CNAME points at ${target}, then remove the domain and add it again.`
            ) : (
              <>
                Your portal answers at{" "}
                <a href={`${protocol}//${domain.hostname}`} className="font-medium text-foreground underline underline-offset-4" target="_blank" rel="noreferrer">
                  {domain.hostname}
                </a>{" "}
                and still at {portalAddress}.
              </>
            )
          }
        >
          {verified && domain.certificate === "pending" && (
            <div>
              <CheckCertificateButton />
            </div>
          )}
        </SetupStep>
      </SetupSteps>
      <div className="flex justify-end border-t pt-4">
        <RemoveDomainButton projectSlug={projectSlug} hostname={domain.hostname} portalAddress={portalAddress} />
      </div>
    </div>
  );
}

function AddDomainForm({ projectSlug }: { projectSlug: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveCustomDomain(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <Field data-invalid={state.error ? true : undefined} className="flex-1">
        <FieldLabel htmlFor="custom-domain" className="sr-only">
          Custom domain
        </FieldLabel>
        <Input id="custom-domain" name="hostname" required maxLength={253} placeholder="help.yourcompany.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Connecting…" : "Connect domain"}
      </Button>
    </form>
  );
}

function CheckDnsButton({ projectSlug, hostname }: { projectSlug: string; hostname: string }) {
  const [pending, startTransition] = useTransition();
  const check = () =>
    startTransition(async () => {
      const result = await verifyCustomDomain(projectSlug);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${hostname} is verified`);
      }
    });
  // Back from the DNS provider's one-click flow (its redirect_uri) with the records added: checked at
  // once, since the CNAME already points at Tuti and visitors get an error until the domain is verified.
  const router = useRouter();
  const params = useSearchParams();
  const back = params.get("dns") === "added" && !params.has("error");
  const checked = useRef(false);
  useEffect(() => {
    if (back && !checked.current) {
      checked.current = true;
      // Once: not again on a reload, or for a domain added next.
      router.replace(window.location.pathname, { scroll: false });
      check();
    }
  });
  return (
    <Button disabled={pending} onClick={check}>
      {pending ? "Checking…" : "Check DNS"}
    </Button>
  );
}

/** Asks again (the page asks Cloudflare about a certificate on its way each time it's shown). */
function CheckCertificateButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button disabled={pending} onClick={() => startTransition(() => router.refresh())}>
      {pending ? "Checking…" : "Check again"}
    </Button>
  );
}

function RemoveDomainButton({ projectSlug, hostname, portalAddress }: { projectSlug: string; hostname: string; portalAddress: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>Remove domain</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Remove {hostname}?</AlertDialogTitle>
          <AlertDialogDescription>Your portal stops answering there. It stays at {portalAddress}.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeCustomDomain(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${hostname} removed`);
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
