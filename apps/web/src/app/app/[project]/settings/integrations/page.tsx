import { prisma } from "@tuti/db";
import { listedRepositories } from "@tuti/jobs";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { CloseOnSelect, DisconnectGithubButton, GithubAccountChoice, GithubRepositories, PrCommentsCheckbox } from "@/components/github-connection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { githubConfig, installationSettingsUrl } from "@/lib/github";
import { repositoryRows } from "@/lib/github-repository-rows";
import { accountsFromCookie, ACCOUNTS_COOKIE } from "@/server/github-connect";
import { getAdminProject } from "@/server/membership";
import { getSession } from "@/server/session";

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected.",
  expired: "That took too long. Try connecting again.",
  refreshed: "Repositories refreshed.",
  unconfirmed: "GitHub couldn't confirm that you can use that installation. Try connecting again.",
};

/** Settings → Integrations: GitHub (pull requests that link posts, move and complete them). */
export default async function IntegrationsSettingsPage(props: PageProps<"/app/[project]/settings/integrations">) {
  const { project: slug } = await props.params;
  const { github: githubResult } = await props.searchParams;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const viewerId = (await getSession())?.user.id ?? "";
  const github = githubConfig();
  // Back from "Connect GitHub" with the accounts the person has the app on.
  const accounts =
    githubResult === "choose" ? accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", project.id) : [];
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
      included: { select: { repoId: true } },
    },
  });
  // Another project's name shows only to people on its team.
  const projectName = (other: { name: string; team: unknown[] }) => (other.team.length > 0 ? other.name : "another project");
  const otherProject = { select: { name: true, team: { where: { userId: viewerId }, select: { userId: true } } } } as const;
  const repositories = installation ? listedRepositories(installation.repositories) : [];
  const elsewhere = installation
    ? await prisma.githubRepository.findMany({
        where: { repoId: { in: repositories.map((repo) => repo.id) }, connectionId: { not: installation.id } },
        select: { repoId: true, connection: { select: { installationId: true, project: otherProject } } },
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            Pull requests that mention a post (tuti#12, or the post&apos;s link) link to it and move it to In progress; shipping them completes it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
            <Alert variant={githubResult === "unconfirmed" || githubResult === "expired" ? "destructive" : "default"}>
              <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
            </Alert>
          )}
          {!github ? (
            <p className="text-muted-foreground">GitHub isn&apos;t set up on this server (see GITHUB_APP_* in .env.example).</p>
          ) : installation ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Connected to <strong>@{installation.accountLogin}</strong>.
                </span>
                <DisconnectGithubButton projectSlug={project.slug} />
              </div>
              <CloseOnSelect projectSlug={project.slug} closeOn={installation.closeOn} />
              <PrCommentsCheckbox projectSlug={project.slug} on={installation.commentOnPullRequests} />
            </>
          ) : accounts.length > 0 ? (
            <GithubAccountChoice projectSlug={project.slug} accounts={accounts} />
          ) : (
            <a href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`} className={buttonVariants({ className: "self-start" })}>
              Connect GitHub
            </a>
          )}
        </CardContent>
      </Card>
      {github && installation && (
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
            <CardDescription>
              Pull requests and releases from these repositories link to and complete this project&apos;s posts. A repository
              belongs to one project; other projects can connect @{installation.accountLogin} for theirs.
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
      )}
    </div>
  );
}
