import { appPortalMount } from "@/lib/app-portal";

export const REPO_URL = "https://github.com/omnivision-solutions/tuti";

/** Tuti's own docs: on its own portal where the server has one, else in the repository. */
export function docsUrl(): string {
  const mount = appPortalMount();
  return mount ? `${mount.origin}${mount.path}/docs` : `${REPO_URL}/tree/main/docs`;
}
