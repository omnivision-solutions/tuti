import { prisma } from "@tuti/db";
import { emailConfigured } from "@tuti/email";
import { notFound } from "next/navigation";

import { ApiKeys } from "@/components/api-keys";
import { AssistantSettings } from "@/components/assistant-settings";
import { BrandingSettings } from "@/components/branding-settings";
import { CustomDomainSettings } from "@/components/custom-domain";
import { SiteMountSettings } from "@/components/site-mount";
import { CloseOnSelect, DisconnectGithubButton, PrCommentsCheckbox } from "@/components/github-connection";
import { Webhooks } from "@/components/webhooks";
import { PageHeader } from "@/components/page-header";
import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalHomeSelect } from "@/components/portal-home-select";
import { PortalReaders } from "@/components/portal-readers";
import { ReaderGroups } from "@/components/reader-groups";
import { SsoSettings } from "@/components/sso-settings";
import { SupportEmailSettings } from "@/components/support-email";
import { WidgetSettings } from "@/components/widget-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { customDomainTarget } from "@/lib/custom-domains";
import { githubConfig } from "@/lib/github";
import { appUrl, portalUrl } from "@/lib/hosts";
import { projectLicense } from "@/server/license";
import { getAdminProject } from "@/server/membership";
import { assistantSettings } from "@/server/operations/assistant";
import { branding } from "@/server/operations/branding";
import { customDomain } from "@/server/operations/domain";
import { groupsWithReaders } from "@/server/operations/groups";
import { siteMountView } from "@/server/operations/site";
import { portalAccess, portalReaders } from "@/server/operations/portal";
import { DEFAULT_WIDGET_COLOR, widgetSettings } from "@/server/operations/widget";

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
    select: { accountLogin: true, closeOn: true, commentOnPullRequests: true },
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
  const widget = (await widgetSettings({ id: project.id }))!;
  const brand = (await branding({ id: project.id }))!;
  const license = await projectLicense(project.id);
  const assistant = await assistantSettings(project.id);
  const { access, home } = await portalAccess(project.id);
  const domain = await customDomain(project.id);
  const site = await siteMountView(project.id);
  const portal = new URL(portalUrl(project.slug));
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
            Pull requests that mention a post (tuti#12, or the post&apos;s link) link to it and move it to In progress;
            shipping them completes it.
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
            <>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Connected to <strong>@{installation.accountLogin}</strong>. Choose its repositories on GitHub.
              </span>
              <DisconnectGithubButton projectSlug={project.slug} />
            </div>
            <CloseOnSelect projectSlug={project.slug} closeOn={installation.closeOn} />
            <PrCommentsCheckbox projectSlug={project.slug} on={installation.commentOnPullRequests} />
            </>
          ) : (
            <a
              href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`}
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
          <CardTitle>Portal access</CardTitle>
          <CardDescription>Who can see your portal, its docs and changelog, and the widget.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalAccessSelect projectSlug={project.slug} access={access} />
          {access === "private" && (
            <PortalReaders projectSlug={project.slug} readers={await portalReaders(project.id)} />
          )}
        </CardContent>
      </Card>

      <Card id="groups" role="region" aria-labelledby="groups-title" className="scroll-mt-6">
        <CardHeader>
          <CardTitle id="groups-title">Groups</CardTitle>
          <CardDescription>
            Readers your app signs in with single sign-on, grouped by the <code>groups</code> in its token. A collection in
            your docs can be for some groups only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReaderGroups projectSlug={project.slug} groups={await groupsWithReaders(project.id)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Home page</CardTitle>
          <CardDescription>What your portal&apos;s address opens.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalHomeSelect projectSlug={project.slug} home={home} />
        </CardContent>
      </Card>

      {/* Only where the server says where customers point their domains (and for one added before that changed). */}
      {(customDomainTarget() || domain) && (
        <Card>
          <CardHeader>
            <CardTitle>Custom domain</CardTitle>
            <CardDescription>Your portal and docs at an address of your own, like help.example.com.</CardDescription>
          </CardHeader>
          <CardContent>
            <CustomDomainSettings projectSlug={project.slug} domain={domain} portalAddress={portal.host} protocol={portal.protocol} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Your site</CardTitle>
          <CardDescription>Your portal and docs under a path of your own site, like example.com/portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <SiteMountSettings projectSlug={project.slug} site={site} portalAddress={portal.host} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
          <CardDescription>How your portal and docs look: your logo, favicon, colour and links.</CardDescription>
        </CardHeader>
        <CardContent>
          <BrandingSettings
            projectSlug={project.slug}
            logo={brand.logo}
            logoDark={brand.logoDark}
            favicon={brand.favicon}
            color={brand.color ?? DEFAULT_WIDGET_COLOR}
            defaultColor={DEFAULT_WIDGET_COLOR}
            headerLinks={brand.headerLinks}
            footerLinks={brand.footerLinks}
            poweredBy={brand.poweredBy}
            licensedUntil={license.licensedUntil}
            buyLicenseUrl={license.buyUrl}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Widget</CardTitle>
          <CardDescription>
            A button on your site that opens feedback, what&apos;s new and docs in a panel. Add it with one script tag:
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <code className="rounded-lg bg-muted p-3 text-xs break-all">
            {`<script src="${appUrl().origin}/widget.js" data-project="${project.slug}" async></script>`}
          </code>
          <WidgetSettings
            projectSlug={project.slug}
            label={widget.label}
            color={widget.color ?? DEFAULT_WIDGET_COLOR}
            defaultColor={DEFAULT_WIDGET_COLOR}
            position={widget.position}
            links={widget.links}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI answers</CardTitle>
          <CardDescription>
            How the AI answers questions in your docs. It only ever answers from your published articles; these
            settings can&apos;t change that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AssistantSettings projectSlug={project.slug} settings={assistant} />
          {/* "Ask a person" emails the team, so it needs email set up on this server. */}
          {emailConfigured() && (
            <SupportEmailSettings projectSlug={project.slug} active={assistant.supportEmail} pending={assistant.supportEmailPending} />
          )}
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

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>
            Download your docs, changelog and feedback as Markdown files in a ZIP, drafts included. Images
            stay links to where they&apos;re hosted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href={`/app/${project.slug}/settings/export`} className={buttonVariants({ variant: "outline" })}>
            Export as Markdown
          </a>
        </CardContent>
      </Card>
    </>
  );
}
