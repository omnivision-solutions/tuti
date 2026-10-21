import { notFound } from "next/navigation";

import { SsoSettings } from "@/components/sso-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card>
      <CardHeader>
        <CardTitle>Single sign-on (JWT)</CardTitle>
        <CardDescription>
          Let users of your app post and vote without creating a separate account. Your server signs a token for the logged-in user and sends
          them to your portal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SsoSettings projectSlug={project.slug} enabled={project.ssoSecret !== null} ssoUrl={`${portalUrl(project.slug)}/sso`} />
      </CardContent>
    </Card>
  );
}
