"use server";

import type { FormState } from "./form-state";
import { updateGlossary } from "./operations/glossary";
import { asAdmin, call } from "./operations/run";

/** Settings → Languages → Glossary (see the glossary.* operations). */

const DENIED = "Only project owners and admins can change the glossary";

export type GlossaryTermInput = { term: string; keep: boolean; translations: Record<string, string> };
export type GlossarySaved = FormState & { retranslating?: number; behind?: number; hash?: string };

/**
 * Saves the glossary's terms over the version `hash` (refused if a teammate saved since), or with `dryRun` only says what
 * saving them would translate again and mark behind. Saved: the new version's hash.
 */
export async function saveGlossary(projectSlug: string, terms: GlossaryTermInput[], hash?: string, dryRun = false): Promise<GlossarySaved> {
  const saved = { retranslating: 0, behind: 0, hash: "" };
  const result = await asAdmin(projectSlug, DENIED, async (context) => {
    Object.assign(saved, await call(updateGlossary, context, { terms: terms as Parameters<typeof updateGlossary.run>[1]["terms"], hash, dryRun }));
  });
  return result.error ? result : { retranslating: saved.retranslating, behind: saved.behind, hash: saved.hash };
}
