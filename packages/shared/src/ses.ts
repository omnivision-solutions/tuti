import { AwsClient } from "aws4fetch";

/**
 * Amazon SES's API (docs/plan.md, Support inbox, item 11), for what its SMTP interface can't do: a
 * tenant per project (and teams' own domains). Sending still goes over `SMTP_*`. On with all five
 * settings; `SES_API_URL` points tests at the SES fake (`@tuti/testkit`).
 */
const SETTINGS = ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_CONFIGURATION_SET", "SES_EVENTS_TOPIC_ARN"] as const;

/** Tenants are named `<configuration set>-<project id>` (25 characters), and SES allows 64. */
const MAX_CONFIGURATION_SET_LENGTH = 38;

/** On startup: some SES settings but not all is a mistake, not "off". */
export function assertSesSettings() {
  const missing = SETTINGS.filter((name) => !process.env[name]);
  if (missing.length > 0 && missing.length < SETTINGS.length) {
    throw new Error(`Amazon SES needs all of ${SETTINGS.join(", ")}: missing ${missing.join(", ")}`);
  }
  if ((process.env.SES_CONFIGURATION_SET?.length ?? 0) > MAX_CONFIGURATION_SET_LENGTH) {
    throw new Error(`SES_CONFIGURATION_SET can be ${MAX_CONFIGURATION_SET_LENGTH} characters at most: projects' tenants are named after it`);
  }
}

export type Ses = {
  /** The configuration set every support email names (its events go to SES_EVENTS_TOPIC_ARN). */
  configurationSet: string;
  /** The ARNs of an identity (a domain verified in SES) and of the configuration set, for tenants. */
  identityArn(domain: string): string;
  configurationSetArn: string;
  /** A project's tenant: named after the configuration set too, so two servers on one SES account keep apart. */
  tenant(projectId: string): string;
  /** Creates a tenant, with its own suppression list (nothing if it's there). */
  createTenant(name: string): Promise<void>;
  /** Lets a tenant's mail use a resource (SES refuses mail naming a tenant that a resource it uses isn't associated with). */
  associate(tenant: string, resourceArn: string): Promise<void>;
  /** Undoes that (nothing if it isn't): SES won't delete an identity a tenant still uses. */
  dissociate(tenant: string, resourceArn: string): Promise<void>;
  /**
   * Adds a team's domain (Easy DKIM, its mail naming the configuration set), tagged with the project
   * it's for; null if SES already has it (see `identity` for whose it is).
   */
  addDomain(domain: string, projectId: string): Promise<{ tokens: string[] } | null>;
  /** A domain SES has: whether it may send (its DKIM records found), its DKIM tokens, and the project it was added for. */
  identity(domain: string): Promise<{ verified: boolean; tokens: string[]; projectId: string | null } | null>;
  /** Removes a domain (nothing if SES doesn't have it). */
  removeDomain(domain: string): Promise<void>;
};

/** The tag naming the project an identity was added for. */
const PROJECT_TAG = "tuti-project";
/** The most an SES call (with its retries) may take. */
const SES_TIMEOUT_MS = 20_000;

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

  /** Calls SESv2: its answer, or "exists" or "missing" when SES says it already has it or doesn't. */
  const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown> | "exists" | "missing"> => {
    const response = await client.fetch(`${base}/v2/email${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // One deadline for the call and its retries: a stalled request ends rather than holding a send (and its lock).
      signal: AbortSignal.timeout(SES_TIMEOUT_MS),
    });
    if (response.ok) {
      // Read in full first: a body cut off by the deadline fails the call rather than reading as empty.
      const text = await response.text();
      try {
        return (JSON.parse(text) ?? {}) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    const error = response.headers.get("x-amzn-errortype") ?? "";
    if (error.startsWith("AlreadyExistsException")) {
      return "exists";
    }
    if (error.startsWith("NotFoundException")) {
      return "missing";
    }
    throw new Error(`SES ${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  };
  const tokens = (answer: Record<string, unknown>) => ((answer.DkimAttributes as { Tokens?: string[] } | undefined)?.Tokens ?? []).slice(0, 3);

  return {
    configurationSet: env.SES_CONFIGURATION_SET!,
    identityArn: (domain) => arn(`identity/${domain}`),
    configurationSetArn: arn(`configuration-set/${env.SES_CONFIGURATION_SET}`),
    tenant: (projectId) => `${env.SES_CONFIGURATION_SET}-${projectId}`,
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
    dissociate: async (tenant, resourceArn) => {
      await call("POST", "/tenants/resources/delete", { TenantName: tenant, ResourceArn: resourceArn });
    },
    addDomain: async (domain, projectId) => {
      const answer = await call("POST", "/identities", {
        EmailIdentity: domain,
        ConfigurationSetName: env.SES_CONFIGURATION_SET,
        Tags: [{ Key: PROJECT_TAG, Value: projectId }],
      });
      if (answer === "missing") {
        throw new Error(`SES couldn't add ${domain}`);
      }
      return answer === "exists" ? null : { tokens: tokens(answer) };
    },
    identity: async (domain) => {
      const answer = await call("GET", `/identities/${encodeURIComponent(domain)}`);
      if (answer === "missing" || answer === "exists") {
        return null;
      }
      const tags = (answer.Tags as { Key: string; Value: string }[] | undefined) ?? [];
      return {
        verified: answer.VerifiedForSendingStatus === true,
        tokens: tokens(answer),
        projectId: tags.find((tag) => tag.Key === PROJECT_TAG)?.Value ?? null,
      };
    },
    removeDomain: async (domain) => {
      await call("DELETE", `/identities/${encodeURIComponent(domain)}`);
    },
  };
}
