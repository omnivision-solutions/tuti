"use server";

import type { FormState } from "./form-state";
import { type ImportView, startImport as startOperation } from "./operations/imports";
import { asAdmin, call } from "./operations/run";

/** The first run's "Check the key and start" (imports.start): the import started, or the one running already. */
export async function startImport(projectSlug: string, source: string, key: string, parts: string[], publishArticles?: boolean, publicPosts?: boolean): Promise<FormState & { import?: ImportView }> {
  let started: ImportView | undefined;
  const result = await asAdmin(projectSlug, "Only the project's owners and admins can import", async (context) => {
    started = await call(startOperation, context, { source: source as never, key: String(key), parts: parts as never, publishArticles, publicPosts });
  });
  return result.error ? result : { import: started };
}
