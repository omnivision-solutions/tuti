"use server";

import type { FormState } from "./form-state";
import { type ImportView, startImport as startOperation } from "./operations/imports";
import { asAdmin, call } from "./operations/run";

/** The first run's "Check the key and start" (imports.start, from Featurebase): the import started, or the one running already. */
export async function startImport(projectSlug: string, key: string, parts: string[]): Promise<FormState & { import?: ImportView }> {
  let started: ImportView | undefined;
  const result = await asAdmin(projectSlug, "Only the project's owners and admins can import", async (context) => {
    started = await call(startOperation, context, { source: "featurebase", key: String(key), parts: parts as never });
  });
  return result.error ? result : { import: started };
}
