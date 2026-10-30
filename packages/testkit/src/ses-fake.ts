import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type SesFakeTenant = { suppression: unknown; resources: Set<string> };
export type SesFakeIdentity = { tags: Record<string, string>; tokens: string[]; configurationSet: string | undefined; verified: boolean };

export type SesFake = {
  url: string;
  /** Env vars that point the app at this fake (all of SES's settings). */
  env: Record<string, string>;
  /** Tenants by name: their suppression settings and the ARNs associated with them. */
  tenants: Map<string, SesFakeTenant>;
  /** Domains added, by name; set `verified` to have SES find their DKIM records. */
  identities: Map<string, SesFakeIdentity>;
  /** Every call, as `<method> <path>`. */
  calls: string[];
  /** Paths that answer 500 while they're in it, to test failures. */
  failing: Set<string>;
  /**
   * Called with each SES call before it's answered: it may wait (to hold the answer back), and a status
   * it returns is the answer instead (500: a failure of that call alone); "cut-off" starts a 200 and
   * drops the connection partway through its body.
   */
  respond?: (path: string, body: Record<string, unknown>) => Promise<number | "cut-off" | void> | number | "cut-off" | void;
  /**
   * A message as SNS posts it for the events topic, signed with the fake's key (its certificate is on
   * the fake): a Notification carries an SES event, a SubscriptionConfirmation a link to confirm.
   * `signed: false` gives it another key's signature.
   */
  sns(type: "Notification" | "SubscriptionConfirmation", message: string, options?: { messageId?: string; topicArn?: string; signed?: boolean }): Record<string, string>;
  /** How many times the subscription was confirmed. */
  confirmations: number;
  close(): Promise<void>;
};

/** What SNS signs for each type, in this order. */
const SNS_SIGNED = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

/**
 * A local stand-in for Amazon SES's API (v2): the calls Tuti makes. Tenants, created with their own
 * suppression list, and resources associated with them; domains (identities), with their DKIM
 * tokens and tags. A repeated create answers SES's
 * `AlreadyExistsException`. Requests must be signed; signatures themselves aren't checked. And SNS's
 * side of the events: signed messages, the certificate, and the link that confirms a subscription.
 */
export async function startSesFake(): Promise<SesFake> {
  const tenants = new Map<string, SesFakeTenant>();
  const identities = new Map<string, SesFakeIdentity>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let confirmations = 0;
  const topicArn = "arn:aws:sns:us-east-1:000000000000:tuti-test-events";
  let url = "";
  const sns: SesFake["sns"] = (type, message, { messageId = randomUUID(), topicArn: topic = topicArn, signed = true } = {}) => {
    const fields: Record<string, string> = {
      Type: type,
      MessageId: messageId,
      TopicArn: topic,
      Message: message,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: `${url}/sns/SimpleNotificationService-fake.pem`,
      ...(type === "SubscriptionConfirmation" && { Token: "fake-token", SubscribeURL: `${url}/sns/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topic)}&Token=fake-token` }),
    };
    const text = SNS_SIGNED[type]
      .filter((field) => field in fields)
      .map((field) => `${field}\n${fields[field]}\n`)
      .join("");
    return { ...fields, Signature: createSign("RSA-SHA256").update(text).sign((signed ? key : otherKey).privateKey, "base64") };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const path = new URL(req.url ?? "/", "http://fake").pathname;
      const query = new URL(req.url ?? "/", "http://fake").searchParams;
      // For journeys in other processes: SES finds a domain's DKIM records (POST /_fake/verify?domain=…).
      if (req.method === "POST" && path === "/_fake/verify") {
        const identity = identities.get(query.get("domain") ?? "");
        if (identity) {
          identity.verified = true;
        }
        return res.writeHead(identity ? 204 : 404).end();
      }
      // For journeys in other processes: an SES event (the body) signed as SNS posts it, to post to /api/email/events.
      if (req.method === "POST" && path === "/_fake/sns") {
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(sns("Notification", Buffer.concat(chunks).toString())));
      }
      if (req.method === "GET" && path === "/sns/SimpleNotificationService-fake.pem") {
        return res.writeHead(200).end(key.publicKey.export({ type: "spki", format: "pem" }));
      }
      if (req.method === "GET" && path === "/sns/" && query.get("Action") === "ConfirmSubscription") {
        if (query.get("TopicArn") !== topicArn || query.get("Token") !== "fake-token") {
          return res.writeHead(400).end();
        }
        confirmations++;
        return res.writeHead(200).end("<ConfirmSubscriptionResponse/>");
      }
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
      // A hook that throws (or rejects) answers 500, rather than leaving the call waiting for its deadline.
      let status: Awaited<ReturnType<NonNullable<SesFake["respond"]>>>;
      try {
        status = await fake.respond?.(path, body);
      } catch {
        status = 500;
      }
      if (status === "cut-off") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        // Dropped once that much has gone out, so the client has its headers and part of the body.
        return res.write('{"DkimAttributes": {"Tok', () => setTimeout(() => res.socket?.destroy(), 20));
      }
      if (status) {
        return answer(status, { message: "Internal failure" }, "InternalFailure");
      }
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
      if (req.method === "POST" && path === "/v2/email/tenants/resources/delete") {
        const tenant = tenants.get(String(body.TenantName));
        if (!tenant?.resources.delete(String(body.ResourceArn))) {
          return answer(404, { message: "Resource association not found" }, "NotFoundException");
        }
        return answer(200);
      }
      if (req.method === "POST" && path === "/v2/email/identities") {
        const domain = String(body.EmailIdentity);
        if (identities.has(domain)) {
          return answer(400, { message: `Email identity ${domain} already exist.` }, "AlreadyExistsException");
        }
        const tokens = [1, 2, 3].map((n) => `${domain.replace(/\W/g, "")}token${n}`);
        const tags = Object.fromEntries(((body.Tags as { Key: string; Value: string }[] | undefined) ?? []).map((tag) => [tag.Key, tag.Value]));
        identities.set(domain, { tags, tokens, configurationSet: body.ConfigurationSetName as string | undefined, verified: false });
        return answer(200, { IdentityType: "DOMAIN", VerifiedForSendingStatus: false, DkimAttributes: { Status: "PENDING", Tokens: tokens } });
      }
      const identityPath = /^\/v2\/email\/identities\/([^/]+)$/.exec(path);
      const identity = identityPath && identities.get(decodeURIComponent(identityPath[1]!));
      if (identityPath && !identity) {
        return answer(404, { message: "Email identity does not exist." }, "NotFoundException");
      }
      if (identity && req.method === "GET") {
        return answer(200, {
          IdentityType: "DOMAIN",
          VerifiedForSendingStatus: identity.verified,
          DkimAttributes: { Status: identity.verified ? "SUCCESS" : "PENDING", Tokens: identity.tokens },
          Tags: Object.entries(identity.tags).map(([Key, Value]) => ({ Key, Value })),
        });
      }
      if (identity && req.method === "DELETE") {
        const domain = decodeURIComponent(identityPath![1]!);
        // Like SES: not while a tenant uses it.
        if ([...tenants.values()].some((t) => [...t.resources].some((arn) => arn.endsWith(`:identity/${domain}`)))) {
          return answer(400, { message: `Cannot delete ${domain} because it has tenant associations` }, "BadRequestException");
        }
        identities.delete(domain);
        return answer(200);
      }
      answer(404, { message: "Not found" }, "NotFoundException");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // `respond` is read from here as each call comes in (the server above answers only after this).
  const fake: SesFake = {
    url,
    env: {
      SES_API_URL: url,
      SES_REGION: "us-east-1",
      SES_ACCESS_KEY_ID: "fake-ses-key",
      SES_SECRET_ACCESS_KEY: "fake-ses-secret",
      SES_CONFIGURATION_SET: "tuti-test",
      SES_EVENTS_TOPIC_ARN: topicArn,
    },
    tenants,
    identities,
    calls,
    failing,
    sns,
    get confirmations() {
      return confirmations;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  return fake;
}
