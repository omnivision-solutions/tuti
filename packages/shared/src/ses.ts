import { AwsClient } from "aws4fetch";

/**
 * Amazon SES's API (docs/plan.md, Support inbox, item 11), for what its SMTP interface can't do: a
 * tenant per project (and teams' own domains). Sending still goes over `SMTP_*`. On with all five
 * settings; `SES_API_URL` points tests at the SES fake (`@tuti/testkit`).
 */
const SETTINGS = ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_CONFIGURATION_SET", "SES_EVENTS_TOPIC_ARN"] as const;

/** On startup: some SES settings but not all is a mistake, not "off". */
export function assertSesSettings() {
  const missing = SETTINGS.filter((name) => !process.env[name]);
  if (missing.length > 0 && missing.length < SETTINGS.length) {
    throw new Error(`Amazon SES needs all of ${SETTINGS.join(", ")}: missing ${missing.join(", ")}`);
  }
}

export type Ses = {
  /** The configuration set every support email names (its events go to SES_EVENTS_TOPIC_ARN). */
  configurationSet: string;
  /** The ARNs of an identity (a domain verified in SES) and of the configuration set, for tenants. */
  identityArn(domain: string): string;
  configurationSetArn: string;
  /** Creates a tenant, with its own suppression list (nothing if it's there). */
  createTenant(name: string): Promise<void>;
  /** Lets a tenant's mail use a resource (SES refuses mail naming a tenant that a resource it uses isn't associated with). */
  associate(tenant: string, resourceArn: string): Promise<void>;
};

/** The configured SES API, or null without the settings. */
export function ses(): Ses | null {
  const env = process.env;
  if (SETTINGS.some((name) => !env[name])) {
    return null;
  }
  const region = env.SES_REGION!;
  // The topic's ARN names the account (arn:aws:sns:<region>:<account>:<name>): the same one as SES's.
  const account = env.SES_EVENTS_TOPIC_ARN!.split(":")[4];
  const client = new AwsClient({ accessKeyId: env.SES_ACCESS_KEY_ID!, secretAccessKey: env.SES_SECRET_ACCESS_KEY!, service: "ses", region, retries: 3 });
  const base = (env.SES_API_URL || `https://email.${region}.amazonaws.com`).replace(/\/$/, "");
  const arn = (resource: string) => `arn:aws:ses:${region}:${account}:${resource}`;

  /** Calls SESv2; SES already having it is fine (each call is safe to repeat). */
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await client.fetch(`${base}/v2/email${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok || response.headers.get("x-amzn-errortype")?.startsWith("AlreadyExistsException")) {
      return;
    }
    throw new Error(`SES ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  };

  return {
    configurationSet: env.SES_CONFIGURATION_SET!,
    identityArn: (domain) => arn(`identity/${domain}`),
    configurationSetArn: arn(`configuration-set/${env.SES_CONFIGURATION_SET}`),
    createTenant: async (name) => {
      await call("POST", "/tenants", {
        TenantName: name,
        // Its own list: an address that complained about one project isn't suppressed for another.
        SuppressionAttributes: { SuppressedReasons: ["BOUNCE", "COMPLAINT"], SuppressionScope: "TENANT" },
      });
    },
    associate: async (tenant, resourceArn) => {
      await call("POST", "/tenants/resources", { TenantName: tenant, ResourceArn: resourceArn });
    },
  };
}
