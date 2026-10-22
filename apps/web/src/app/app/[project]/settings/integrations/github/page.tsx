import { prisma } from "@tuti/db";
import { listedRepositories } from "@tuti/jobs";
import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CloseOnSelect, DisconnectGithubButton, GithubRepositories, PrCommentsCheckbox } from "@/components/github-connection";
import { GithubMark } from "@/components/github-mark";
import { IntegrationLogo } from "@/components/integration-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, timeAgo } from "@/lib/format";
import { githubConfig, installationSettingsUrl } from "@/lib/github";
import { repositoryRows } from "@/lib/github-repository-rows";
import { getAdminProject } from "@/server/membership";
import { getSession } from "@/server/session";

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected. Add the repositories that belong to this project.",
  refreshed: "Repositories refreshed.",
};

/**
 * Settings → Integrations → GitHub (Manage): the connection's settings, by what they're about:
 * the project's repositories, what pull requests do, and when linked posts ship.
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
      closeOn: true,
      commentOnPullRequests: true,
      repositories: true,
      createdAt: true,
      included: { select: { repoId: true } },
    },
  });
  const integrations = `/app/${project.slug}/settings/integrations`;
  if (!github || !installation) {
    redirect(integrations);
  }
  // Another project's name shows only to people on its team.
  const viewerId = (await getSession())?.user.id ?? "";
  const projectName = (other: { name: string; team: unknown[] }) => (other.team.length > 0 ? other.name : "another project");
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
        <DisconnectGithubButton projectSlug={project.slug} />
      </div>
      {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
        <Alert>
          <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <CardDescription>
            Pull requests and releases from these repositories link to and complete this project&apos;s posts. A repository belongs to one
            project; other projects can connect @{installation.accountLogin} for theirs.
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
            manageUrl={installationSettingsUrl(github, installation.installationId, {
              login: installation.accountLogin,
              type: installation.accountType,
            })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pull requests</CardTitle>
          <CardDescription>
            A pull request that mentions a post (tuti#12, or the post&apos;s link) in its title, description or commits links to it, and
            opening it moves the post to In progress.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <PrCommentsCheckbox projectSlug={project.slug} on={installation.commentOnPullRequests} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shipping</CardTitle>
          <CardDescription>
            Completing a post emails the people who asked for it. Merged pull requests also gather in the changelog&apos;s Next release draft.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <CloseOnSelect projectSlug={project.slug} closeOn={installation.closeOn} />
        </CardContent>
      </Card>
    </div>
  );
}
