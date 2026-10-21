import { checkWebhookUrl, publicOnlyLookup } from "@tuti/shared/webhook-url";
import { Agent, fetch } from "undici";

const publicOnly = new Agent({ connect: { lookup: publicOnlyLookup } });

/**
 * What a team's site answers at `url` ("Check setup" for a portal under its path), the first
 * kilobyte as text, or null when it isn't a 200. The site is the team's, so the same rules as
 * webhooks keep it from reaching our own network (private addresses, DNS rebinding); no redirects.
 */
export async function fetchSiteCheck(url: string): Promise<string | null> {
  await checkWebhookUrl(url);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    ...(process.env.WEBHOOK_ALLOW_PRIVATE_URLS !== "true" && { dispatcher: publicOnly }),
    headers: { "user-agent": "Tuti-Site-Check/1" },
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  // Only the start: a token is short, and a site could send anything.
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < 1024) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, 1024).toString("utf8");
}
