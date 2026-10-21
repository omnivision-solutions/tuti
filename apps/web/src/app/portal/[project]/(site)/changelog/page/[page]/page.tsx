import { notFound, permanentRedirect } from "next/navigation";

import { changelogMetadata, changelogPage } from "@/components/changelog-pages";
import { portalLinks } from "@/server/portal-base";

export async function generateMetadata(props: PageProps<"/portal/[project]/changelog/page/[page]">) {
  return changelogMetadata((await props.params).project);
}

/** Older changelog entries: /changelog/page/2 and on (the first page is /changelog; past the last, a 404). */
export default async function OlderChangelogPage(props: PageProps<"/portal/[project]/changelog/page/[page]">) {
  const { project, page: param } = await props.params;
  const page = Number(param);
  // One address per page: no "02", and nothing past what a page count could reach.
  if (!Number.isInteger(page) || String(page) !== param || page < 1 || page > 10_000) {
    notFound();
  }
  if (page === 1) {
    permanentRedirect((await portalLinks())("/changelog"));
  }
  return changelogPage(project, page);
}
