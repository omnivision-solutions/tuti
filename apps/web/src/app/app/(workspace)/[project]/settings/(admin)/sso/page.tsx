import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
import { SettingsPane } from "@/components/settings-card";
import { portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Single sign-on · Settings" };

/** Settings → Single sign-on: the JWT secret the team's app signs its users in with. */
export default async function SsoSettingsPage(props: PageProps<"/app/[project]/settings/sso">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <SettingsPane title="Single sign-on">
      <SsoSettings projectSlug={project.slug} enabled={project.ssoSecret !== null} portal={portalUrl(project.slug)} signInUrl={project.ssoSignInUrl} />
    </SettingsPane>
  );
}
