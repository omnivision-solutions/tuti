import type { Metadata } from "next";
import { LANGUAGE_CODES, LANGUAGES, languageLimit, roomierPlan } from "@tuti/shared";
import { notFound } from "next/navigation";

import { LanguageSettings } from "@/components/language-settings";
import { SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { languagesFull, projectLanguages, publishedPages } from "@/server/operations/languages";

export const metadata: Metadata = { title: "Languages · Settings" };

/** Settings → Portal → Languages (docs/plan.md, Languages): the language the team writes in, and the others the portal is in. */
export default async function LanguagesPage(props: PageProps<"/app/[project]/settings/languages">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [saved, pages] = await Promise.all([projectLanguages(project.id), publishedPages(project.id)]);
  const limit = languageLimit(project.plan);
  const full = limit !== null && 1 + saved.languages.length >= limit;
  const billingHref = roomierPlan(project.plan, languageLimit) ? `/app/${slug}/settings/billing` : null;
  return (
    <SettingsPane title="Languages" description="Your portal, help center and changelog in more than one language">
      <LanguageSettings
        projectSlug={slug}
        defaultLanguage={saved.default.code}
        languages={saved.languages}
        offered={LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGES[code] }))}
        pages={pages}
        upgrade={full ? { title: languagesFull(project.plan, limit), billingHref, note: null } : null}
        // Past the limit (after a downgrade) only the oldest within it can be live: Go live on the rest offers the upgrade.
        pastLimit={limit === null ? [] : saved.languages.slice(Math.max(limit - 1, 0)).map(({ code }) => code)}
        goLiveUpgrade={limit === null ? null : { title: languagesFull(project.plan, limit, "make more live"), billingHref, note: null }}
      />
    </SettingsPane>
  );
}
