/** Tuti's help center, where each guide below is an article (the "Support email" collection). */
const HELP = "https://tuti.so/help/docs";

/** Using a team's own address, both ways, and forwarding it with any other provider. */
export const EMAIL_FORWARDING_DOCS = `${HELP}/own-email-address`;

/** An email provider, known by its MX hosts, and its forwarding guide. */
export type MailProvider = { name: string; docs: string };

const PROVIDERS: { name: string; article: string; mx: RegExp }[] = [
  { name: "Google Workspace", article: "forward-from-google-workspace", mx: /(^|\.)(google|googlemail)\.com$/ },
  { name: "Microsoft 365", article: "forward-from-microsoft-365", mx: /(^|\.)(outlook\.com|mx\.microsoft)$/ },
  { name: "Zoho Mail", article: "forward-from-zoho-mail", mx: /(^|\.)(zoho(mail)?\.(com|com\.au|com\.cn|ae|eu|in|jp|uk|sa)|zohocloud\.ca)$/ },
  { name: "Fastmail", article: "forward-from-fastmail", mx: /(^|\.)messagingengine\.com$/ },
  { name: "Proton Mail", article: "forward-from-proton-mail", mx: /(^|\.)protonmail\.ch$/ },
  { name: "Cloudflare Email Routing", article: "forward-with-cloudflare-email-routing", mx: /(^|\.)mx\.cloudflare\.net$/ },
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
  return known ? { name: known.name, docs: `${HELP}/${known.article}` } : "other";
}
