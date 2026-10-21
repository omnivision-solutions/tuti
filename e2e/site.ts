/** The team's own website (the site fake, see global-setup.ts): its origin, and making it forward a path to a portal. */
export const siteUrl = () => process.env.E2E_SITE_URL!;

export async function forwardToPortal(path: string, portal: string) {
  const response = await fetch(`${siteUrl()}/_fake/forward`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, target: portal }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't make the site forward ${path} (${response.status})`);
  }
}
