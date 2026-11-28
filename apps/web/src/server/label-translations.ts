"use server";

import type { Language } from "@tuti/shared";

import type { FormState } from "./form-state";
import { updateBoardTranslation, updateCollectionTranslation, updateTabTranslation } from "./operations/label-translations";
import { asAdmin, asTeam, call } from "./operations/run";

/** A collection's, a tab's and a board's settings → Translations (see the collections.*, tabs.* and boards.*Translation operations). */

const DENIED = "Only the project's team can edit the docs";

export type LabelTranslationInput = { keepUpToDate: boolean; name: string; description: string };

/** A collection's name and description in `language`: the team's own, or kept up to date. */
export async function saveCollectionTranslation(projectSlug: string, slug: string, language: string, input: LabelTranslationInput): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(updateCollectionTranslation, context, {
      slug,
      language: language as Language,
      keepUpToDate: input.keepUpToDate,
      ...(!input.keepUpToDate && { name: input.name, description: input.description }),
    }),
  );
}

/** A tab's name in `language`: the team's own, or kept up to date. */
export async function saveTabTranslation(projectSlug: string, slug: string, language: string, input: Omit<LabelTranslationInput, "description">): Promise<FormState> {
  return asTeam(projectSlug, DENIED, (context) =>
    call(updateTabTranslation, context, { slug, language: language as Language, keepUpToDate: input.keepUpToDate, ...(!input.keepUpToDate && { name: input.name }) }),
  );
}


/** A board's name and description in `language`: the team's own, or kept up to date (owners and admins, as its settings). */
export async function saveBoardTranslation(projectSlug: string, slug: string, language: string, input: LabelTranslationInput): Promise<FormState> {
  return asAdmin(projectSlug, "Only project owners and admins can manage boards", (context) =>
    call(updateBoardTranslation, context, {
      slug,
      language: language as Language,
      keepUpToDate: input.keepUpToDate,
      ...(!input.keepUpToDate && { name: input.name, description: input.description }),
    }),
  );
}
