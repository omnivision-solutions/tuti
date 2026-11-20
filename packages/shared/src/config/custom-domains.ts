import { z } from "zod";

/** Portals on their own domains (help.acme.com). The Cloudflare token stays an env var (CLOUDFLARE_API_TOKEN): it's a secret. */
export const customDomains = z
  .strictObject({
    target: z
      .string()
      .describe(
        "The hostname customers point their domain at with a CNAME (\"customers.example.com\"); your proxy sends any host there to the app and gets it a TLS certificate. Empty: custom domains are off",
      )
      .default(""),
    cloudflareZoneId: z
      .string()
      .describe("Cloudflare for SaaS gets the domains' certificates instead: its zone (Custom Hostnames on, fallback origin `customDomains.target`), with CLOUDFLARE_API_TOKEN. Empty: not used")
      .default(""),
  })
  .prefault({});

/** The variables this section replaced: setting one stops start-up (checkConfig). */
export const CUSTOM_DOMAINS_REPLACED = {
  CUSTOM_DOMAIN_TARGET: "customDomains.target",
  CLOUDFLARE_ZONE_ID: "customDomains.cloudflareZoneId",
};
