/** Amazon SES (the fake, see global-setup.ts) finds a domain's DKIM records, as it would once the team adds them. */
export async function verifySesDomain(domain: string) {
  const response = await fetch(`${process.env.E2E_SES_URL}/_fake/verify?domain=${encodeURIComponent(domain)}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`SES (the fake) doesn't have ${domain}`);
  }
}
