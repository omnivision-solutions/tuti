import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { LANGUAGE_CODES, LANGUAGES, languageLimit, roomierPlan } from "@tuti/shared";
import { notFound } from "next/navigation";

import { LanguageSettings } from "@/components/language-settings";
import { SettingsPane } from "@/components/settings-card";
import { getAdminProject } from "@/server/membership";
import { languagesFull, projectLanguages } from "@/server/operations/languages";

export const metadata: Metadata = { title: "Languages · Settings" };

/** Settings → Portal → Languages (docs/plan.md, Languages): the language the team writes in, and the others the portal is in. */
export default async function LanguagesPage(props: PageProps<"/app/[project]/settings/languages">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [saved, pages] = await Promise.all([
    projectLanguages(project.id),
    prisma.article.count({ where: { projectId: project.id, publishedAt: { not: null } } }),
  ]);
  const limit = languageLimit(project.plan);
  const full = limit !== null && 1 + saved.languages.length >= limit;
  return (
    <SettingsPane title="Languages" description="Your portal, help center and changelog in more than one language">
      <LanguageSettings
        projectSlug={slug}
        defaultLanguage={saved.default.code}
        languages={saved.languages}
        offered={LANGUAGE_CODES.map((code) => ({ code, ...LANGUAGES[code] }))}
        pages={pages}
        upgrade={full ? { title: languagesFull(project.plan, limit), billingHref: roomierPlan(project.plan, languageLimit) ? `/app/${slug}/settings/billing` : null, note: null } : null}
      />
    </SettingsPane>
  );
}
