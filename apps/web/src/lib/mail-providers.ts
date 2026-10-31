/** How to forward a team's own address to its support address, per email provider (docs/email-forwarding.md). */
export const EMAIL_FORWARDING_DOCS = "https://github.com/omnivision-solutions/tuti/blob/main/docs/email-forwarding.md";

/** An email provider, known by its MX hosts, and its section of docs/email-forwarding.md. */
export type MailProvider = { name: string; docs: string };

const PROVIDERS: { name: string; anchor: string; mx: RegExp }[] = [
  { name: "Google Workspace", anchor: "google-workspace", mx: /(^|\.)(google|googlemail)\.com$/ },
  { name: "Microsoft 365", anchor: "microsoft-365", mx: /(^|\.)(outlook\.com|mx\.microsoft)$/ },
  { name: "Zoho Mail", anchor: "zoho-mail", mx: /(^|\.)(zoho(mail)?\.(com|com\.au|com\.cn|ae|eu|in|jp|uk|sa)|zohocloud\.ca)$/ },
  { name: "Fastmail", anchor: "fastmail", mx: /(^|\.)messagingengine\.com$/ },
  { name: "Proton Mail", anchor: "proton-mail", mx: /(^|\.)protonmail\.ch$/ },
  { name: "Cloudflare Email Routing", anchor: "cloudflare-email-routing", mx: /(^|\.)mx\.cloudflare\.net$/ },
];

/**
 * Who receives a domain's email, from its MX hosts: a provider with a guide, "none" (nothing
 * receives it yet, so it needs a forwarding service first), or "other" (a guide in general).
 */
export function mailProvider(mx: string[]): MailProvider | "none" | "other" {
  if (mx.length === 0) {
    return "none";
  }
  const known = PROVIDERS.find((provider) => mx.some((host) => provider.mx.test(host)));
  return known ? { name: known.name, docs: `${EMAIL_FORWARDING_DOCS}#${known.anchor}` } : "other";
}
