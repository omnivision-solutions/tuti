import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { listedRepositories } from "@tuti/jobs";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { GithubAccountChoice, GithubConnectionMenu, GithubRepositories } from "@/components/github-connection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { formatDate } from "@/lib/format";
import { githubConfig, installationSettingsUrl } from "@/lib/github";
import { repositoryRows } from "@/lib/github-repository-rows";
import { accountsFromCookie, ACCOUNTS_COOKIE } from "@/server/github-connect";
import { getAdminProject } from "@/server/membership";
import { getSession } from "@/server/session";

export const metadata: Metadata = { title: "GitHub · Settings" };

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected. Add the repositories that belong to this project.",
};

/**
 * Settings → Integrations → GitHub (Manage): the connection (its account in the header, with what's rarely done to it
 * under ⋯) and the project's repositories.
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
      included: { select: { repoId: true, fullName: true } },
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
  // The list, and the project's own even if it isn't on it (a reconnect by someone who can't access one, as it was added), to remove.
  const listed = listedRepositories(installation.repositories);
  const repositories = [
    ...listed,
    ...installation.included.filter((row) => !listed.some((repo) => repo.id === row.repoId)).map((row) => ({ id: row.repoId, fullName: row.fullName })),
  ];
  const elsewhere = await prisma.githubRepository.findMany({
    where: { repoId: { in: repositories.map((repo) => repo.id) }, connectionId: { not: installation.id } },
    select: {
      repoId: true,
      connection: {
        select: { installationId: true, project: { select: { name: true, team: { where: { userId: viewerId }, select: { userId: true } } } } },
      },
    },
  });

  const connected = (className: string) => (
    <Badge className={className} title={`Connected ${formatDate(installation.createdAt)}`}>
      Connected · {installation.accountLogin}
    </Badge>
  );

  return (
    <SettingsPane
      title="GitHub"
      back={{ href: integrations, label: "Integrations" }}
      actions={
        <>
          {connected("hidden @min-[48rem]/app:inline-flex")}
          <GithubConnectionMenu
            projectSlug={project.slug}
            account={installation.accountLogin}
            switchUrl={github ? `/api/github/install?${new URLSearchParams({ project: project.slug })}` : null}
          />
        </>
      }
    >
      {/* On a phone the header has no room for it: here, where a long account name wraps. */}
      {connected("-mb-3 h-auto max-w-full justify-start text-left break-all whitespace-normal @min-[48rem]/app:hidden")}
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
        <SettingsCard
          title="Switch account"
          description={
            <>
              This project&apos;s repositories from @{installation.accountLogin} are removed, and you add the new account&apos;s.
            </>
          }
        >
          <SettingBlock className="text-sm">
            <GithubAccountChoice projectSlug={project.slug} accounts={accounts} />
          </SettingBlock>
        </SettingsCard>
      )}

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
        reconnectUrl={`/api/github/use?${new URLSearchParams({ project: project.slug, installation: String(installation.installationId) })}`}
      />
    </SettingsPane>
  );
}
