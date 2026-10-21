"use client";

import { useRouter } from "next/navigation";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
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
 * Settings → Custom domain (see the domain.* operations): the portal at an address of the team's
 * own. They add it, add the DNS records it shows, and check; once verified the portal answers there.
 */
export function CustomDomainSettings({ projectSlug, domain, portalAddress, protocol }: { projectSlug: string; domain: Domain | null; portalAddress: string; protocol: string }) {
  if (!domain) {
    return <AddDomainForm projectSlug={projectSlug} portalAddress={portalAddress} />;
  }
  const verified = domain.status === "verified";
  const target = domain.records.find((record) => record.type === "CNAME")?.value;
  const badge = !verified
    ? { label: "Waiting for DNS", variant: "secondary" as const }
    : domain.certificate === "pending"
      ? { label: "Certificate pending", variant: "secondary" as const }
      : domain.certificate === "failed"
        ? { label: "Certificate failed", variant: "destructive" as const }
        : { label: "Verified", variant: "default" as const };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{domain.hostname}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {verified && domain.certificate === "pending" ? (
          `Verified. Your portal's HTTPS certificate there is on its way: it takes a few minutes once ${domain.hostname} points at ${target}. Check again in a moment.`
        ) : verified && domain.certificate === "failed" ? (
          `We couldn't get an HTTPS certificate for ${domain.hostname}. Check that its CNAME points at ${target}, then remove the domain and add it again.`
        ) : verified ? (
          <>
            Your portal answers at{" "}
            <a href={`${protocol}//${domain.hostname}`} className="underline" target="_blank" rel="noreferrer">
              {domain.hostname}
            </a>{" "}
            and still at {portalAddress}. Keep these records at your DNS provider:
          </>
        ) : (
          "Add these records at your domain's DNS provider, then check. DNS changes can take a few minutes to show."
        )}
      </p>
      <dl className="grid gap-3 text-sm">
        {domain.records.map((record) => (
          <div key={record.type} className="grid gap-1 rounded-lg bg-muted p-3">
            <dt className="font-medium">{record.type}</dt>
            <dd className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <span className="text-muted-foreground">Name</span>
              <code className="break-all">{record.name}</code>
              <span className="text-muted-foreground">{record.type === "CNAME" ? "Target" : "Value"}</span>
              <code className="break-all">{record.value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        {!verified && <CheckDnsButton projectSlug={projectSlug} hostname={domain.hostname} />}
        {verified && domain.certificate === "pending" && <CheckCertificateButton />}
        <RemoveDomainButton projectSlug={projectSlug} hostname={domain.hostname} portalAddress={portalAddress} />
      </div>
    </div>
  );
}

function AddDomainForm({ projectSlug, portalAddress }: { projectSlug: string; portalAddress: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveCustomDomain(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3">
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="custom-domain">Domain</FieldLabel>
        <Input id="custom-domain" name="hostname" required maxLength={253} placeholder="help.example.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        <FieldDescription>A subdomain of a domain you own. The portal stays at {portalAddress} too.</FieldDescription>
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
        Add domain
      </Button>
    </form>
  );
}

function CheckDnsButton({ projectSlug, hostname }: { projectSlug: string; hostname: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await verifyCustomDomain(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`${hostname} is verified`);
          }
        })
      }
    >
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
      <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>Remove</AlertDialogTrigger>
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
