"use client";

import { CheckIcon, FolderIcon, GlobeIcon, LinkIcon, type LucideIcon } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";

import { CopyButton } from "@/components/copy-button";
import { CustomDomainSettings } from "@/components/custom-domain";
import { SiteMountSettings } from "@/components/site-mount";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Domain = ComponentProps<typeof CustomDomainSettings>["domain"];
type Site = ComponentProps<typeof SiteMountSettings>["site"];
type Choice = "tuti" | "domain" | "site";

/**
 * Settings → Domain: where the portal goes live. Its Tuti address (every portal has one), a domain
 * of the team's own, or a path of their site: one of the last two at most (domain.set and site.set
 * each refuse while the other is set). Once one is connected, it's picked and the others say to
 * remove it first.
 */
export function OwnAddressSettings({
  projectSlug,
  domain,
  site,
  domainsOn,
  notIncluded,
  portalAddress,
  protocol,
  oneClick,
}: {
  projectSlug: string;
  domain: Domain;
  site: Site;
  /** Whether this server can put portals on custom domains (CUSTOM_DOMAIN_TARGET). */
  domainsOn: boolean;
  /** What the project's plan doesn't include, each saying which plan does (null: included). */
  notIncluded: { domain: string | null; site: string | null };
  /** The portal's Tuti address, as a host (acme.tuti.so). */
  portalAddress: string;
  /** Where the domain's DNS provider can add its records itself, while they're needed. */
  oneClick?: ComponentProps<typeof CustomDomainSettings>["oneClick"];
  protocol: string;
}) {
  const connected: Choice | null = domain ? "domain" : site ? "site" : null;
  const [picked, setPicked] = useState<Choice>(connected ?? "tuti");
  const choice = connected ?? picked;
  const tuti = `${protocol}//${portalAddress}`;
  const domainSettings = <CustomDomainSettings projectSlug={projectSlug} domain={domain} portalAddress={portalAddress} protocol={protocol} oneClick={oneClick} />;
  const siteSettings = <SiteMountSettings projectSlug={projectSlug} site={site} portalAddress={portalAddress} tutiAddress={tuti} />;

  const options: { value: Choice; title: string; example: string; icon: LucideIcon; off?: string }[] = [
    { value: "tuti", title: "Tuti address", example: portalAddress, icon: LinkIcon },
    {
      value: "domain",
      title: "Custom domain",
      example: "help.yourcompany.com",
      icon: GlobeIcon,
      off: !domainsOn ? "Not set up on this server" : (notIncluded.domain ?? undefined),
    },
    { value: "site", title: "Sub-folder", example: "yourcompany.com/help", icon: FolderIcon, off: notIncluded.site ?? undefined },
  ];
  const current = domain?.hostname ?? site?.url.replace(/^https?:\/\//, "");

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>How do you want to go live?</CardTitle>
          <CardDescription>Where your portal and docs answer.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div role="radiogroup" aria-label="Where your portal goes live" className="flex flex-col gap-3">
            {options.map(({ value, title, example, icon: Icon, off }) => {
              const selected = choice === value;
              // Locked while another is connected: they remove it first.
              const locked = connected !== null && !selected;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={locked || Boolean(off)}
                  onClick={() => {
                    if (off) {
                      return;
                    }
                    if (locked) {
                      toast.error(`Remove ${current} before switching.`);
                      return;
                    }
                    setPicked(value);
                  }}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                    selected ? "border-primary ring-1 ring-primary" : "hover:bg-accent",
                    (locked || off) && "opacity-60 hover:bg-transparent",
                  )}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{title}</span>
                    <span className="truncate text-sm text-muted-foreground">{off ?? example}</span>
                  </span>
                  {selected && <CheckIcon className="ml-auto size-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
          {connected && <p className="text-sm text-muted-foreground">To switch, remove {current} first.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Both, from before a portal could only have one: show both, so either can be removed. */}
          {domain && site ? (
            <>
              <p className="text-sm text-muted-foreground">
                Your portal has a domain of its own and a sub-folder of your site. It can only have one: remove the one you don&apos;t want.
              </p>
              {domainSettings}
              {siteSettings}
            </>
          ) : choice === "domain" ? (
            domainSettings
          ) : choice === "site" ? (
            siteSettings
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                Your portal is at{" "}
                <a href={tuti} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                  {portalAddress}
                </a>
                .
              </p>
              <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                <code className="text-sm break-all">{tuti}</code>
                <CopyButton value={tuti} label="your portal's address" />
              </div>
              <p className="text-sm text-muted-foreground">Every portal has one. It keeps working with a domain or a sub-folder too: the widget loads from it.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
