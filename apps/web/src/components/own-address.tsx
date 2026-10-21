"use client";

import { type ComponentProps, useState } from "react";

import { CustomDomainSettings } from "@/components/custom-domain";
import { SiteMountSettings } from "@/components/site-mount";

type Domain = ComponentProps<typeof CustomDomainSettings>["domain"];
type Site = ComponentProps<typeof SiteMountSettings>["site"];

const CHOICES = [
  ["domain", "A domain of its own", "help.example.com"],
  ["site", "A path of your site", "example.com/portal"],
] as const;

/**
 * Settings → Your own address: the portal at a domain of the team's own or under a path of their
 * site, one or the other (domain.set and site.set each refuse while the other is set). Once one is
 * set, only that one shows; to switch, they remove it.
 */
export function OwnAddressSettings({
  projectSlug,
  domain,
  site,
  domainsOn,
  portalAddress,
  protocol,
}: {
  projectSlug: string;
  domain: Domain;
  site: Site;
  /** Whether this server can put portals on custom domains (CUSTOM_DOMAIN_TARGET). */
  domainsOn: boolean;
  portalAddress: string;
  protocol: string;
}) {
  const [choice, setChoice] = useState<"domain" | "site">("domain");
  const domainSettings = <CustomDomainSettings projectSlug={projectSlug} domain={domain} portalAddress={portalAddress} protocol={protocol} />;
  const siteSettings = <SiteMountSettings projectSlug={projectSlug} site={site} portalAddress={portalAddress} />;

  // Both, from before a portal could only have one: show both, so either can be removed.
  if (domain && site) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Your portal has a domain of its own and a path of your site. It can only have one: remove the one you don&apos;t want.
        </p>
        {domainSettings}
        {siteSettings}
      </div>
    );
  }
  if (domain) {
    return (
      <div className="flex flex-col gap-4">
        {domainSettings}
        <p className="text-sm text-muted-foreground">To put your portal under a path of your site instead, remove this domain first.</p>
      </div>
    );
  }
  if (site) {
    return (
      <div className="flex flex-col gap-4">
        {siteSettings}
        {domainsOn && <p className="text-sm text-muted-foreground">To give your portal a domain of its own instead, remove it from your site first.</p>}
      </div>
    );
  }
  if (!domainsOn) {
    return siteSettings;
  }
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Where your portal goes</legend>
        <div className="flex flex-wrap gap-4">
          {CHOICES.map(([value, name, example]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input type="radio" name="own-address" value={value} checked={choice === value} onChange={() => setChoice(value)} className="size-4 accent-primary" />
              {name} <span className="text-muted-foreground">({example})</span>
            </label>
          ))}
        </div>
      </fieldset>
      {choice === "domain" ? domainSettings : siteSettings}
    </div>
  );
}
