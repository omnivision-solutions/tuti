import { prisma } from "@tuti/db";
import { listedRepositories } from "@tuti/jobs";
import { ArrowLeftRightIcon, ChevronLeftIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { DisconnectGithubButton, GithubAccountChoice, GithubRepositories } from "@/components/github-connection";
import { GithubMark } from "@/components/github-mark";
import { IntegrationLogo } from "@/components/integration-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { githubConfig, installationSettingsUrl } from "@/lib/github";
import { repositoryRows } from "@/lib/github-repository-rows";
import { accountsFromCookie, ACCOUNTS_COOKIE } from "@/server/github-connect";
import { getAdminProject } from "@/server/membership";
import { getSession } from "@/server/session";

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected. Add the repositories that belong to this project.",
};

/**
 * Settings → Integrations → GitHub (Manage): the connection and the project's repositories.
 */
export default async function GithubIntegrationPage(props: PageProps<"/app/[project]/settings/integrations/github">) {
  const { project: slug } = await props.params;
  const { github: githubResult } = await props.searchParams;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const github = githubConfig();
  const installation = await prisma.githubInstallation.findUnique({
    where: { projectId: project.id },
    select: {
      id: true,
      installationId: true,
      accountLogin: true,
      accountType: true,
      repositories: true,
      createdAt: true,
      included: { select: { repoId: true } },
    },
  });
  const integrations = `/app/${project.slug}/settings/integrations`;
  if (!installation) {
    redirect(integrations);
  }
  // Another project's name shows only to people on its team.
  const viewerId = (await getSession())?.user.id ?? "";
  const projectName = (other: { name: string; team: unknown[] }) => (other.team.length > 0 ? other.name : "another project");
  // Back from "Switch account" with the other accounts the person has the app on.
  const accounts =
    githubResult === "choose"
      ? accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", project.id).filter(
          (account) => account.id !== installation.installationId,
        )
      : null;
  const repositories = listedRepositories(installation.repositories);
  const elsewhere = await prisma.githubRepository.findMany({
    where: { repoId: { in: repositories.map((repo) => repo.id) }, connectionId: { not: installation.id } },
    select: {
      repoId: true,
      connection: {
        select: { installationId: true, project: { select: { name: true, team: { where: { userId: viewerId }, select: { userId: true } } } } },
      },
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <Link href={integrations} className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-4" />
        Back to integrations
      </Link>
      <div className="flex flex-wrap items-center gap-4">
        <IntegrationLogo>
          <GithubMark className="size-6" />
        </IntegrationLogo>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate font-heading text-lg font-medium">GitHub · {installation.accountLogin}</h2>
          <span className="text-sm text-muted-foreground" title={formatDate(installation.createdAt)}>
            Connected {timeAgo(installation.createdAt)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {github && (
            <a
              href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ArrowLeftRightIcon />
              Switch account
            </a>
          )}
          <DisconnectGithubButton projectSlug={project.slug} account={installation.accountLogin} />
        </div>
      </div>
      {!github && (
        <Alert variant="destructive">
          <AlertDescription>
            GitHub isn&apos;t set up on this server any more (GITHUB_APP_* in .env.example), so nothing reaches this project from it. Set it up
            again, or disconnect.
          </AlertDescription>
        </Alert>
      )}
      {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
        <Alert>
          <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
        </Alert>
      )}
      {accounts && (
        <Card>
          <CardHeader>
            <CardTitle>Switch account</CardTitle>
            <CardDescription>
              This project&apos;s repositories from @{installation.accountLogin} are removed, and you add the new account&apos;s.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <GithubAccountChoice projectSlug={project.slug} accounts={accounts} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            Merged pull requests from these repositories gather in the changelog&apos;s Next release draft. Each repository belongs to one project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GithubRepositories
            // Fresh state after a refresh or another tab's change.
            key={JSON.stringify([repositories, installation.included])}
            projectSlug={project.slug}
            account={installation.accountLogin}
            repositories={repositoryRows(
              repositories,
              installation.included.map((row) => row.repoId),
              elsewhere.map((row) => ({
                repoId: row.repoId,
                installationId: row.connection.installationId,
                project: projectName(row.connection.project),
              })),
              installation.installationId,
            )}
            manageUrl={
              github
                ? installationSettingsUrl(github, installation.installationId, { login: installation.accountLogin, type: installation.accountType })
                : null
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
