import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

/** Settings → Single sign-on: the JWT secret the team's app signs its users in with. */
export default async function SsoSettingsPage(props: PageProps<"/app/[project]/settings/sso">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  return (
    <SettingsPane title="Single sign-on" description="Let users of your app post and vote without creating a separate account. Your server signs a token (a JWT) for the logged-in user and sends them to your portal.">
      <SettingsCard>
        <SettingBlock>
          <SsoSettings projectSlug={project.slug} enabled={project.ssoSecret !== null} ssoUrl={`${portalUrl(project.slug)}/sso`}
            signInUrl={project.ssoSignInUrl}
          />
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
