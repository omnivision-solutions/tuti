"use server";

import type { FormState } from "./form-state";
import { getGlossary, updateGlossary } from "./operations/glossary";
import { asAdmin, call } from "./operations/run";

/** Settings → Languages → Glossary (see the glossary.* operations). */

const DENIED = "Only project owners and admins can change the glossary";

export type GlossaryTermInput = { term: string; keep: boolean; translations: Record<string, string> };
export type GlossarySaved = FormState & {
  retranslating?: number;
  behind?: number;
  hash?: string;
  /** Refused as a teammate saved since `hash`: the glossary as it is now, to merge with. */
  latest?: { terms: GlossaryTermInput[]; hash: string };
};

/**
 * Saves the glossary's terms over the version `hash` (refused if a teammate saved since), or with `dryRun` only says what
 * saving them would translate again and mark behind. Saved: the new version's hash.
 */
export async function saveGlossary(projectSlug: string, terms: GlossaryTermInput[], hash?: string, dryRun = false): Promise<GlossarySaved> {
  const saved = { retranslating: 0, behind: 0, hash: "" };
  const result = await asAdmin(projectSlug, DENIED, async (context) => {
    Object.assign(saved, await call(updateGlossary, context, { terms: terms as Parameters<typeof updateGlossary.run>[1]["terms"], hash, dryRun }));
  });
  if (result.error && hash) {
    // Refused: if the glossary moved on since `hash`, its newest version too.
    const now: GlossarySaved = {};
    await asAdmin(projectSlug, DENIED, async (context) => {
      now.latest = await call(getGlossary, context, {});
    });
    return now.latest && now.latest.hash !== hash ? { ...result, latest: now.latest } : result;
  }
  return result.error ? result : { retranslating: saved.retranslating, behind: saved.behind, hash: saved.hash };
}
