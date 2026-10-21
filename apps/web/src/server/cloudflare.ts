import type { CertificateStatus } from "@tuti/db";

/**
 * Cloudflare for SaaS: a custom hostname per verified custom domain, so Cloudflare gets it a
 * certificate and sends its requests to CUSTOM_DOMAIN_TARGET (the zone's fallback origin). On
 * when CLOUDFLARE_API_TOKEN (SSL and Certificates: Edit on the zone) and CLOUDFLARE_ZONE_ID are
 * set; without them, the server's own proxy gets certificates for custom domains.
 */

export function cloudflareConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID);
}

type Hostname = { id: string; hostname: string; status: string; ssl?: { status?: string } };
type Answer<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

/** A Cloudflare API call failed; `codes` are Cloudflare's error codes. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = process.env.CLOUDFLARE_API_URL || "https://api.cloudflare.com/client/v4";
  const response = await fetch(`${base}/zones/${process.env.CLOUDFLARE_ZONE_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const answer = (await response.json().catch(() => null)) as Answer<T> | null;
  if (!response.ok || !answer?.success) {
    const errors = answer?.errors ?? [];
    throw new CloudflareError(`Cloudflare answered ${response.status}: ${errors.map((e) => `${e.code} ${e.message}`).join("; ")}`, response.status, errors.map((e) => e.code));
  }
  return answer.result;
}

/** A certificate's status, as Tuti keeps it. */
export function certificateStatus(hostname: Hostname): CertificateStatus {
  const ssl = hostname.ssl?.status ?? "";
  if (hostname.status === "active" && ssl === "active") {
    return "ACTIVE";
  }
  if (["blocked", "moved", "deleted"].includes(hostname.status) || ["validation_timed_out", "expired", "deleted", "issuance_timed_out"].includes(ssl)) {
    return "FAILED";
  }
  return "PENDING";
}

/** Duplicate custom hostname: it's in the zone already (made before, and not removed). */
const DUPLICATE = 1406;

/** Makes the custom hostname (or finds the one there already) for `hostname`. */
export async function createCustomHostname(hostname: string): Promise<Hostname> {
  try {
    // HTTP validation: Cloudflare checks the certificate's domain once the CNAME points at us.
    return await api<Hostname>("POST", "/custom_hostnames", { hostname, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } });
  } catch (error) {
    if (error instanceof CloudflareError && error.codes.includes(DUPLICATE)) {
      const [existing] = await api<Hostname[]>("GET", `/custom_hostnames?${new URLSearchParams({ hostname })}`);
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}

export function getCustomHostname(id: string): Promise<Hostname> {
  return api<Hostname>("GET", `/custom_hostnames/${encodeURIComponent(id)}`);
}

/** Deletes the custom hostname; one that's gone already is fine. */
export async function deleteCustomHostname(id: string): Promise<void> {
  try {
    await api<unknown>("DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
  } catch (error) {
    if (!(error instanceof CloudflareError && error.status === 404)) {
      throw error;
    }
  }
}
