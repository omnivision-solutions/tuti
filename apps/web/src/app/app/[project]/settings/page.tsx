import { notFound, redirect } from "next/navigation";

import { isAdminRole } from "@/lib/roles";
import { settingsGroups } from "@/lib/settings-pages";
import { getMembership } from "@/server/membership";

/** Settings opens on its first page someone may see (Access was here before the menu: its links still land). */
export default async function SettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const pages = settingsGroups(slug, isAdminRole(membership.role)).flatMap((group) => group.pages);
  redirect(pages.find((page) => page.href.endsWith("/access"))?.href ?? pages[0]!.href);
}
