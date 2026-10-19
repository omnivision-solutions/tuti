import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { ApiKeys } from "@/components/api-keys";
import { PageHeader } from "@/components/page-header";
import { SsoSettings } from "@/components/sso-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

export default async function SettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    // Team members who aren't owners/admins get the same response as outsiders.
    notFound();
  }
  const keys = await prisma.apiKey.findMany({
    where: { projectId: project.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, scope: true, prefix: true, createdAt: true, lastUsedAt: true },
  });

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

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Use this project&apos;s feedback from your own code (REST API) or an AI assistant (MCP). Keys are shown
            once; revoke any you no longer use. <a href="/docs/api" className="text-primary underline underline-offset-4">API docs</a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeys projectSlug={project.slug} keys={keys} apiUrl={`${appUrl().origin}/api/v1`} />
        </CardContent>
      </Card>
    </>
  );
}
