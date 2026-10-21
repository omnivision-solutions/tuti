import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

const underPaths = new Map<string, typeof authClient>();

/** The auth client for a portal under a path of its team's site: the auth API is under that path too. */
export function authClientAt(base: string): typeof authClient {
  if (!base) {
    return authClient;
  }
  let client = underPaths.get(base);
  if (!client) {
    client = createAuthClient({ basePath: `${base}/api/auth` }) as typeof authClient;
    underPaths.set(base, client);
  }
  return client;
}
