"use server";

import type { FormState } from "./form-state";
import { updateGlossary } from "./operations/glossary";
import { asAdmin, call } from "./operations/run";

/** Settings → Languages → Glossary (see the glossary.* operations). */

const DENIED = "Only project owners and admins can change the glossary";

export type GlossaryTermInput = { term: string; keep: boolean; translations: Record<string, string> };
export type GlossarySaved = FormState & { retranslating?: number; behind?: number };

/** Saves the glossary's terms, or with `dryRun` only says what saving them would translate again and mark behind. */
export async function saveGlossary(projectSlug: string, terms: GlossaryTermInput[], dryRun = false): Promise<GlossarySaved> {
  const counts = { retranslating: 0, behind: 0 };
  const result = await asAdmin(projectSlug, DENIED, async (context) => {
    Object.assign(counts, await call(updateGlossary, context, { terms: terms as Parameters<typeof updateGlossary.run>[1]["terms"], dryRun }));
  });
  return result.error ? result : { retranslating: counts.retranslating, behind: counts.behind };
}
