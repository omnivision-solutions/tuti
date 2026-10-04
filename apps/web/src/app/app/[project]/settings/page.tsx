import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SsoSettings } from "@/components/sso-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

export default async function SettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    // Team members who aren't owners/admins get the same response as outsiders.
    notFound();
  }

  return (
    <>
      <PageHeader title="Settings" description="Owners and admins only." />

      <Card>
        <CardHeader>
          <CardTitle>Single sign-on (JWT)</CardTitle>
          <CardDescription>
            Let users of your app post and vote without creating a separate account. Your server signs a token for
            the logged-in user and sends them to your portal.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SsoSettings
            projectSlug={project.slug}
            enabled={project.ssoSecret !== null}
            ssoUrl={`${portalUrl(project.slug)}/sso`}
          />
        </CardContent>
      </Card>
    </>
  );
}
