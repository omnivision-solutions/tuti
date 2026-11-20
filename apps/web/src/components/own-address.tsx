"use client";

import { CheckIcon, CopyIcon, FolderIcon, GlobeIcon, LinkIcon, type LucideIcon } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { copyText } from "@/components/copy-button";
import { CustomDomainSettings } from "@/components/custom-domain";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { SiteMountSettings } from "@/components/site-mount";
import { Button } from "@/components/ui/button";
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
  // Removed (its Remove button, which had focus, goes with it): focus goes to the option still picked.
  const group = useRef<HTMLDivElement>(null);
  const was = useRef(connected);
  useEffect(() => {
    if (was.current && !connected) {
      group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
    was.current = connected;
  }, [connected]);
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
    <SettingsCard title="Portal address">
      <SettingBlock className="gap-3">
        {/* Side by side; one under another where the card is a phone's width. */}
        <div ref={group} role="radiogroup" aria-label="Where your portal goes live" className="grid gap-2 @min-[34rem]/settings:grid-cols-3">
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
                  "flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected ? "border-primary bg-soft ring-1 ring-primary" : "hover:bg-accent",
                  (locked || off) && "opacity-60 hover:bg-transparent",
                )}
              >
                <Icon aria-hidden className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{title}</span>
                  {/* What it needs (a plan, the server's setup) is said whole; an example address is cut where it doesn't fit. */}
                  <span className={cn("text-sm text-muted-foreground", !off && "truncate")}>{off ?? example}</span>
                </span>
                {selected && <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
        {connected && <p className="text-sm text-muted-foreground">To switch, remove {current} first.</p>}
      </SettingBlock>

      {/* Both, from before a portal could only have one: show both, so either can be removed. */}
      {domain && site ? (
        <SettingBlock className="text-sm">
          <p className="text-sm text-muted-foreground">Your portal has a domain of its own and a sub-folder of your site. It can only have one: remove the one you don&apos;t want.</p>
          {domainSettings}
          {siteSettings}
        </SettingBlock>
      ) : choice === "domain" ? (
        <SettingBlock className="text-sm">{domainSettings}</SettingBlock>
      ) : choice === "site" ? (
        // Its form is rows of its own; once set up, a block.
        site ? (
          <SettingBlock className="text-sm">{siteSettings}</SettingBlock>
        ) : (
          siteSettings
        )
      ) : (
        <SettingRow label="Your Tuti address" description="Always works, also beside a domain.">
          <div className="flex min-w-0 items-center gap-1 @min-[34rem]/settings:max-w-80">
            <a href={tuti} target="_blank" rel="noreferrer" className="min-w-0 flex-1 font-mono text-xs break-all underline-offset-4 hover:underline">
              {tuti}
            </a>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy your portal's address" title="Copy" onClick={() => copyText(tuti)} className="text-muted-foreground">
              <CopyIcon />
            </Button>
          </div>
        </SettingRow>
      )}
    </SettingsCard>
  );
}
