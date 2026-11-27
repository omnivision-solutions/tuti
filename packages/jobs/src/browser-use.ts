/**
 * Browser Use Cloud's API (v4): an agent in a cloud browser, for Screenshots (screenshots.ts). Its address is
 * BROWSER_USE_API_URL (the testkit's fake in tests), and its key BROWSER_USE_API_KEY.
 */

const DEFAULT_URL = "https://api.browser-use.com/api/v4";
/** One request's time limit: every call here is a small JSON read or write. */
const REQUEST_MS = 30_000;

export class BrowserUseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrowserUseError";
  }
}

export type RunStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";
export const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

export type RunSummary = {
  id: string;
  status: RunStatus;
  result: string | null;
  output?: unknown;
  error: string | null;
  sessionId: string;
  workspaceId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: string;
};

export type SessionCost = { llmCostUsd: string; searchCostUsd: string; browserCostUsd: string; proxyCostUsd: string; proxyUsedMb: string; totalCostUsd: string };

export type SecretBinding = { alias: string; source: { type: "inline"; value: string }; allowedDomains: string[] };

/** A client for one key: each method one request, throwing BrowserUseError for anything but a 2xx. */
export function browserUse(key = process.env.BROWSER_USE_API_KEY?.trim() ?? "") {
  const base = (process.env.BROWSER_USE_API_URL?.trim() || DEFAULT_URL).replace(/\/$/, "");
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "X-Browser-Use-API-Key": key, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new BrowserUseError(response.status, `Browser Use answered ${response.status} to ${method} ${path.replace(/\?.*/, "")}: ${text.slice(0, 300)}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
  return {
    createWorkspace: (name: string) => request<{ id: string }>("POST", "/workspaces", { name }),
    createRun: (body: {
      task: string;
      model: string;
      workspaceId: string;
      maxCostUsd: number;
      outputSchema: object;
      secretBindings?: SecretBinding[];
      /** Always sent: null turns off Browser Use's residential proxy (on by default, billed per GB); "us" is it. */
      /** `networkPolicyId`: the domains its browser may open (networkPolicy, screenshots.ts). */
      /** `profileId`: the browser profile it starts from and saves to when stopped (browserProfile, screenshots.ts). */
      browserSettings: { screenWidth: number; screenHeight: number; proxyCountryCode: "us" | null; networkPolicyId: string; profileId?: string };
    }) => request<{ id: string; status: RunStatus; sessionId: string; workspaceId: string }>("POST", "/runs", body),
    /** A network policy: only `allow`'s domains (and their subdomains) open, with `defaultAction` block. */
    createNetworkPolicy: (body: { name: string; defaultAction: "block"; allow: { domains: string[] } }) => request<{ id: string }>("POST", "/network-policies", body),
    updateNetworkPolicy: (id: string, body: { defaultAction: "block"; allow: { domains: string[] } }) => request<{ id: string }>("PATCH", `/network-policies/${id}`, body),
    deleteNetworkPolicy: (id: string) => request<void>("DELETE", `/network-policies/${id}`),
    /** A browser profile: cookies and storage, kept between browsers given it. 402: the account's limit reached. */
    createProfile: (name: string) => request<{ id: string }>("POST", "/profiles", { name }),
    deleteProfile: (id: string) => request<void>("DELETE", `/profiles/${id}`),
    runStatus: (id: string) => request<{ status: RunStatus }>("GET", `/runs/${id}/status`),
    run: (id: string) => request<RunSummary>("GET", `/runs/${id}`),
    files: (workspaceId: string, includeUrls = true) =>
      request<{ files: { path: string; size: number; url?: string | null }[] }>("GET", `/workspaces/${workspaceId}/files?includeUrls=${includeUrls}&limit=100`),
    deleteFile: (workspaceId: string, path: string) => request<void>("DELETE", `/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`),
    activeBrowsers: (sessionId: string) =>
      request<{ items: { id: string; status: string }[] }>("GET", `/browsers?agentSessionId=${encodeURIComponent(sessionId)}&filterBy=active&pageSize=100`),
    stopBrowser: (id: string) => request<unknown>("PATCH", `/browsers/${id}`, { action: "stop" }),
    sessionCost: (sessionId: string) => request<SessionCost>("GET", `/sessions/${sessionId}/cost`),
  };
}

export type BrowserUse = ReturnType<typeof browserUse>;
