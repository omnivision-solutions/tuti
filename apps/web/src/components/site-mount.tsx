"use client";

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
import type { FormState } from "@/server/form-state";
import { removeSiteMount, saveSite, verifySiteSetup } from "@/server/portal-settings";

type Site = { url: string; status: "pending" | "verified"; forward: { from: string; to: string }[] };

/**
 * Customize → Address (see the site.* operations): the portal under a path of the team's own site
 * (acme.com/portal). They set the address, make their site forward the path to Tuti, and check it.
 */
export function SiteMountSettings({ projectSlug, site, portalAddress }: { projectSlug: string; site: Site | null; portalAddress: string }) {
  if (!site) {
    return <AddSiteForm projectSlug={projectSlug} portalAddress={portalAddress} />;
  }
  const verified = site.status === "verified";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{site.url}</span>
        <Badge variant={verified ? "default" : "secondary"}>{verified ? "Verified" : "Waiting for your site"}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {verified
          ? `Your portal answers at ${site.url}, and every link Tuti makes goes there. Keep your site forwarding:`
          : "Make your site forward these to Tuti, paths and all (rewrite or proxy rules): the path, and /_tuti for the portal's scripts and styles. Then check:"}
      </p>
      {site.forward.map((rule) => (
        <dl key={rule.from} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted p-3 text-sm">
          <dt className="text-muted-foreground">From</dt>
          <dd>
            <code className="break-all">{rule.from}</code>
          </dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>
            <code className="break-all">{rule.to}</code>
          </dd>
        </dl>
      ))}
      <div className="flex flex-wrap gap-2">
        {!verified && <CheckSiteButton projectSlug={projectSlug} url={site.url} />}
        <RemoveSiteButton projectSlug={projectSlug} url={site.url} portalAddress={portalAddress} />
      </div>
    </div>
  );
}

function AddSiteForm({ projectSlug, portalAddress }: { projectSlug: string; portalAddress: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveSite(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3">
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="site-url">Address</FieldLabel>
        <Input id="site-url" name="url" required maxLength={500} placeholder="https://example.com/portal" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        <FieldDescription>Your site and the path your portal goes under. Until it&apos;s checked, the portal stays at {portalAddress}.</FieldDescription>
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-start">
        Add address
      </Button>
    </form>
  );
}

function CheckSiteButton({ projectSlug, url }: { projectSlug: string; url: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await verifySiteSetup(projectSlug);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(`Your portal is at ${url}`);
          }
        })
      }
    >
      {pending ? "Checking…" : "Check setup"}
    </Button>
  );
}

function RemoveSiteButton({ projectSlug, url, portalAddress }: { projectSlug: string; url: string; portalAddress: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" disabled={pending} />}>Remove</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Stop using {url}?</AlertDialogTitle>
          <AlertDialogDescription>Your portal stops answering there. It stays at {portalAddress}.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await removeSiteMount(projectSlug);
                if (result.error) {
                  toast.error(result.error);
                } else {
                  toast.success(`${url} removed`);
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
