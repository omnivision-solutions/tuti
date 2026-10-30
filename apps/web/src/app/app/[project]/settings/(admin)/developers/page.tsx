import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { ApiKeys } from "@/components/api-keys";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Webhooks } from "@/components/webhooks";
import { appUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

/** Settings → Developers: API keys (REST and MCP) and webhooks. */
export default async function DevelopersSettingsPage(props: PageProps<"/app/[project]/settings/developers">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [keys, webhooks] = await Promise.all([
    prisma.apiKey.findMany({
      where: { projectId: project.id, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, scope: true, prefix: true, createdAt: true, lastUsedAt: true },
    }),
    prisma.webhook.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        url: true,
        events: true,
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, deliveredAt: true, lastError: true, attempts: true },
        },
      },
    }),
  ]);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Use this project&apos;s feedback from your own code (REST API) or an AI assistant (MCP). Keys are shown once; revoke any you no longer
            use. <a href="/docs/api" className="text-primary underline underline-offset-4">API docs</a>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeys projectSlug={project.slug} keys={keys} apiUrl={`${appUrl().origin}/api/v1`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Tuti sends a signed POST to your endpoint when something happens, and retries for about a day until it answers with a 2xx.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Webhooks
            projectSlug={project.slug}
            webhooks={webhooks.map(({ deliveries, ...webhook }) => ({ ...webhook, lastDelivery: deliveries[0] ?? null }))}
          />
        </CardContent>
      </Card>
    </>
  );
}
