import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type SesFakeTenant = { suppression: unknown; resources: Set<string> };

export type SesFake = {
  url: string;
  /** Env vars that point the app at this fake (all of SES's settings). */
  env: Record<string, string>;
  /** Tenants by name: their suppression settings and the ARNs associated with them. */
  tenants: Map<string, SesFakeTenant>;
  /** Every call, as `<method> <path>`. */
  calls: string[];
  /** Paths that answer 500 while they're in it, to test failures. */
  failing: Set<string>;
  close(): Promise<void>;
};

/**
 * A local stand-in for Amazon SES's API (v2): the calls Tuti makes. Tenants, created with their own
 * suppression list, and resources associated with them. A repeated create answers SES's
 * `AlreadyExistsException`. Requests must be signed; signatures themselves aren't checked.
 */
export async function startSesFake(): Promise<SesFake> {
  const tenants = new Map<string, SesFakeTenant>();
  const calls: string[] = [];
  const failing = new Set<string>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://fake").pathname;
      calls.push(`${req.method} ${path}`);
      const answer = (status: number, body: unknown = {}, errorType?: string) =>
        res.writeHead(status, { "content-type": "application/json", ...(errorType && { "x-amzn-errortype": `${errorType}:http://internal.amazon.com/` }) }).end(JSON.stringify(body));
      if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        return answer(403, { message: "Missing Authentication Token" }, "UnrecognizedClientException");
      }
      if (failing.has(path)) {
        return answer(500, { message: "Internal failure" }, "InternalFailure");
      }
      const body = (chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}) as Record<string, unknown>;
      if (req.method === "POST" && path === "/v2/email/tenants") {
        const name = String(body.TenantName);
        if (tenants.has(name)) {
          return answer(400, { message: `Tenant ${name} already exists` }, "AlreadyExistsException");
        }
        tenants.set(name, { suppression: body.SuppressionAttributes, resources: new Set() });
        return answer(200, { TenantName: name });
      }
      if (req.method === "POST" && path === "/v2/email/tenants/resources") {
        const tenant = tenants.get(String(body.TenantName));
        if (!tenant) {
          return answer(404, { message: "Tenant not found" }, "NotFoundException");
        }
        const arn = String(body.ResourceArn);
        if (tenant.resources.has(arn)) {
          return answer(400, { message: `Resources ${arn} has already been associated` }, "AlreadyExistsException");
        }
        tenant.resources.add(arn);
        return answer(200);
      }
      answer(404, { message: "Not found" }, "NotFoundException");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    env: {
      SES_API_URL: url,
      SES_REGION: "us-east-1",
      SES_ACCESS_KEY_ID: "fake-ses-key",
      SES_SECRET_ACCESS_KEY: "fake-ses-secret",
      SES_CONFIGURATION_SET: "tuti-test",
      SES_EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:tuti-test-events",
    },
    tenants,
    calls,
    failing,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
