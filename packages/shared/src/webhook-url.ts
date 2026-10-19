import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Webhook URLs are entered by customers and called by our servers, so they must
 * never reach our own network (cloud metadata, databases, internal services).
 * Checked when a webhook is saved and again before every delivery, since DNS can
 * change. ponytail: the request resolves the name again, so a rebinding DNS server
 * could still swap the address in between; pin the address in the connection if
 * that ever matters.
 *
 * Self-hosters calling their own internal services can allow private addresses
 * with WEBHOOK_ALLOW_PRIVATE_URLS=true (tests do too).
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

function isPrivate(address: string): boolean {
  // IPv4 written as IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) {
    return blocked.check(mapped, "ipv4");
  }
  return blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

/** Throws with a message for people if `url` can't be used as a webhook. */
export async function checkWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a full URL, like https://example.com/tuti-webhook");
  }
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_URLS === "true";
  if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) {
    throw new Error("Webhook URLs must start with https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Put credentials in your endpoint's checks, not in the URL");
  }
  if (allowPrivate) {
    return;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  } catch {
    throw new Error(`${host} can't be found`);
  }
  if (addresses.length === 0 || addresses.some(isPrivate)) {
    throw new Error("Webhook URLs must point to a public address");
  }
}
