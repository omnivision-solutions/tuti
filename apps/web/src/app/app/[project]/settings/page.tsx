import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { ApiKeys } from "@/components/api-keys";
import { DisconnectGithubButton } from "@/components/github-connection";
import { Webhooks } from "@/components/webhooks";
import { PageHeader } from "@/components/page-header";
import { SsoSettings } from "@/components/sso-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { githubConfig, signInstallState } from "@/lib/github";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected.",
  unconfirmed: "GitHub couldn't confirm that you can use that installation. Try connecting again.",
  taken: "That GitHub account is already connected to another project.",
};

export default async function SettingsPage(props: PageProps<"/app/[project]/settings">) {
  const { project: slug } = await props.params;
  const { github: githubResult } = await props.searchParams;
  const project = await getAdminProject(slug);
  if (!project) {
    // Team members who aren't owners/admins get the same response as outsiders.
    notFound();
  }
  const github = githubConfig();
  const installation = await prisma.githubInstallation.findUnique({
    where: { projectId: project.id },
    select: { accountLogin: true },
  });
  const webhooks = await prisma.webhook.findMany({
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
  });
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
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Pull requests that mention a post (tuti#12, or the post&apos;s link) link to it and move it to In progress.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
            <Alert variant={githubResult === "connected" ? "default" : "destructive"}>
              <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
            </Alert>
          )}
          {!github ? (
            <p className="text-muted-foreground">GitHub isn&apos;t set up on this server (see GITHUB_APP_* in .env.example).</p>
          ) : installation ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Connected to <strong>@{installation.accountLogin}</strong>. Choose its repositories on GitHub.
              </span>
              <DisconnectGithubButton projectSlug={project.slug} />
            </div>
          ) : (
            <a
              href={`${github.url}/apps/${github.appSlug}/installations/new?${new URLSearchParams({ state: signInstallState(project.id) })}`}
              className={buttonVariants({ className: "self-start" })}
            >
              Connect GitHub
            </a>
          )}
        </CardContent>
      </Card>

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

      <Card>
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
          <CardDescription>
            Tuti sends a signed POST to your endpoint when something happens, and retries for about a day until it
            answers with a 2xx.
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
