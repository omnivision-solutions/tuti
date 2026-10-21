"use client";

import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
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
import { CopyButton, CopyField } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { keepingFields } from "@/lib/forms";
import { type SiteGuide, siteGuides } from "@/lib/site-guides";
import type { FormState } from "@/server/form-state";
import { removeSiteMount, saveSite, verifySiteSetup } from "@/server/portal-settings";

/** The guide for every other platform (the rules in general). */
const SITE_PATH_DOCS = "https://github.com/omnivision-solutions/tuti/blob/main/docs/site-path.md";

type Site = { url: string; status: "pending" | "verified"; forward: { from: string; to: string }[] };

/**
 * Customize → Address → Sub-folder (see the site.* operations): the portal under a path of the
 * team's own site (yourcompany.com/help). They set the site and the path, make their site forward
 * them to Tuti (a guide per platform, with their own rules written out), and check it.
 */
export function SiteMountSettings({ projectSlug, site, portalAddress, tutiAddress }: { projectSlug: string; site: Site | null; portalAddress: string; tutiAddress: string }) {
  if (!site) {
    return <AddSiteForm projectSlug={projectSlug} portalAddress={portalAddress} />;
  }
  const verified = site.status === "verified";
  const path = new URL(site.url).pathname;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium break-all">{site.url.replace(/^https?:\/\//, "")}</span>
        <Badge variant={verified ? "default" : "secondary"}>{verified ? "Verified" : "Waiting for your site"}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {verified
          ? `Your portal answers at ${site.url}, and every link Tuti makes goes there. Keep your site forwarding:`
          : "Make your site forward these to Tuti, paths and all (rewrite or proxy rules): the path, and /_tuti for the portal's scripts and styles. Then check:"}
      </p>
      {site.forward.map((rule) => (
        <section key={rule.from} aria-label={`Forward ${rule.from}`} className="flex flex-col gap-2">
          <CopyField label="From" name={`${rule.from} from`} value={rule.from} />
          <CopyField label="To" name={`${rule.from} to`} value={rule.to} />
        </section>
      ))}
      <SiteGuides path={path} tutiAddress={tutiAddress} />
      <div className="flex flex-wrap justify-end gap-2">
        {!verified && <CheckSiteButton projectSlug={projectSlug} url={site.url} />}
        <RemoveSiteButton projectSlug={projectSlug} url={site.url} portalAddress={portalAddress} />
      </div>
    </div>
  );
}

/** "Pick the platform your site runs on": each opens its rules for this portal, ready to paste; and docs for the rest. */
function SiteGuides({ path, tutiAddress }: { path: string; tutiAddress: string }) {
  const [open, setOpen] = useState<SiteGuide | null>(null);
  const guides = siteGuides({ path, tuti: tutiAddress });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">To set it up, pick the platform your site runs on:</p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {guides.map((guide) => (
          <li key={guide.id}>
            <button type="button" onClick={() => setOpen(guide)} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent">
              {guide.name}
              <ChevronRightIcon className="size-4 text-muted-foreground" />
            </button>
          </li>
        ))}
        <li>
          <a
            href={SITE_PATH_DOCS}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm hover:bg-accent"
          >
            My platform isn&apos;t listed
            <ExternalLinkIcon className="size-4 text-muted-foreground" />
          </a>
        </li>
      </ul>
      <Sheet open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>Put your portal under {path} with {open.name}</SheetTitle>
                <SheetDescription>{open.where}</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 px-4 pb-4">
                <div className="rounded-lg border">
                  <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
                    <span className="text-xs text-muted-foreground">{open.language}</span>
                    <CopyButton value={open.code} label={`${open.name} rules`} />
                  </div>
                  <pre className="overflow-x-auto px-3 py-2 text-xs">
                    <code>{open.code}</code>
                  </pre>
                </div>
                <p className="text-sm text-muted-foreground">
                  Then come back here and choose Check setup. Forward requests as a proxy does, not as a redirect: your visitors only ever see your site.
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The site's address and the path, as two fields: saveSite puts them together. */
function AddSiteForm({ projectSlug, portalAddress }: { projectSlug: string; portalAddress: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>((prev, formData) => saveSite(projectSlug, prev, formData), {});
  return (
    <form {...keepingFields(action)} className="flex flex-col gap-3">
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="site-origin">Your site</FieldLabel>
        <Input id="site-origin" name="site" required maxLength={300} placeholder="https://yourcompany.com" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        <FieldDescription>The site your portal goes under.</FieldDescription>
      </Field>
      <Field data-invalid={state.error ? true : undefined}>
        <FieldLabel htmlFor="site-path">Path</FieldLabel>
        <Input id="site-path" name="path" required maxLength={200} placeholder="/help" autoComplete="off" aria-invalid={state.error ? true : undefined} />
        <FieldDescription>Where on it, like /help or /support. Until it&apos;s checked, the portal stays at {portalAddress}.</FieldDescription>
        {state.error && <FieldError>{state.error}</FieldError>}
      </Field>
      <Button type="submit" disabled={pending} className="self-end">
        {pending ? "Setting up…" : "Set up sub-folder"}
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
      <AlertDialogTrigger render={<Button variant="destructive" disabled={pending} />}>Remove sub-folder</AlertDialogTrigger>
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
