import type { Metadata } from "next";
import { projectGlossary } from "@tuti/jobs";
import { isLanguage, LANGUAGES } from "@tuti/shared";
import { notFound } from "next/navigation";

import { GlossarySettings } from "@/components/glossary-settings";
import { getAdminProject } from "@/server/membership";
import { withHash } from "@/server/operations/glossary";
import { projectLanguages } from "@/server/operations/languages";

export const metadata: Metadata = { title: "Glossary · Languages · Settings" };

/** Settings → Languages → Glossary (docs/plan.md, Languages, L12): terms never translated, or translated one way per language. */
export default async function GlossaryPage(props: PageProps<"/app/[project]/settings/languages/glossary">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [terms, saved] = await Promise.all([projectGlossary(project.id), projectLanguages(project.id)]);
  const languages = saved.languages.flatMap(({ code }) => (isLanguage(code) ? [{ code, native: LANGUAGES[code].native }] : []));
  return <GlossarySettings projectSlug={slug} languages={languages} {...withHash(terms)} />;
}
