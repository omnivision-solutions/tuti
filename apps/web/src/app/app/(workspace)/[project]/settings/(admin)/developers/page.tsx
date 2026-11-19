import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { ArrowUpRightIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { ApiKeys, CreateKeyDialog } from "@/components/api-keys";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { AddWebhookDialog, Webhooks } from "@/components/webhooks";
import { appUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Developers · Settings" };

/** Settings → Developers: API keys (REST and MCP) and webhooks, each a list with its count (once it has any) and its "add" dialog. */
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
    <SettingsPane
      title="Developers"
      actions={
        <a href="/api/docs" className="inline-flex items-center gap-0.5 text-sm text-primary underline underline-offset-4">
          API docs
          <ArrowUpRightIcon aria-hidden className="size-3.5" />
        </a>
      }
    >
      <SettingsCard title="API keys" count={keys.length || undefined} action={<CreateKeyDialog projectSlug={project.slug} apiUrl={`${appUrl().origin}/api/v1`} />}>
        <ApiKeys projectSlug={project.slug} keys={keys} />
      </SettingsCard>

      <SettingsCard title="Webhooks" count={webhooks.length || undefined} action={<AddWebhookDialog projectSlug={project.slug} />}>
        <Webhooks
          projectSlug={project.slug}
          webhooks={webhooks.map(({ deliveries, ...webhook }) => ({ ...webhook, lastDelivery: deliveries[0] ?? null }))}
        />
      </SettingsCard>
    </SettingsPane>
  );
}
