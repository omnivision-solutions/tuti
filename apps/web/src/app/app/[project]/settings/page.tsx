import { notFound, redirect } from "next/navigation";

import { isAdminRole } from "@/lib/roles";
import { settingsGroups } from "@/lib/settings-pages";
import { getMembership } from "@/server/membership";

/** Settings opens on its first page someone may see: General for owners and admins, Team & roles for the rest. */
export default async function SettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  redirect(settingsGroups(slug, isAdminRole(membership.role))[0]!.pages[0]!.href);
}
