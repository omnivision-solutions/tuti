import { labelIn } from "@tuti/jobs";

import { portalLanguage } from "./portal-base";

/**
 * Names the team gives boards, for this portal page (docs/plan.md, Languages, L14; as L9 does a collection's): a board's
 * name and description in the page's language where they're translated and current (labelIn), marked with that language's
 * `lang`; else the team's, marked with the team's (the project's default). Off the portal (no page language), the team's,
 * with no `lang`.
 */
export async function boardNames() {
  const { language, defaultLanguage } = await portalLanguage().catch(() => ({ language: null, defaultLanguage: null }));
  // Its description required (null for none): a translation is current only for the name and description it was made from.
  return <T extends { name: string; description: string | null; translations: unknown }>(board: T): T & { lang?: string } => {
    const translated = labelIn({ ...board, description: board.description ?? "" }, language);
    if (translated) {
      // Its description there too (none where it has none there: never the team's beside a translated name).
      return { ...board, name: translated.name, description: translated.description || null, lang: language! };
    }
    return { ...board, lang: defaultLanguage ?? undefined };
  };
}
