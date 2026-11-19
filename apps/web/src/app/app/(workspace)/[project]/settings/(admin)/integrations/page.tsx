import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { aiProvider, codeChangesEnabled } from "@tuti/shared";
import { cn } from "cn";
import { ChevronRightIcon, GitMergeIcon, HashIcon, SquareKanbanIcon, TicketIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { GithubAccountChoice } from "@/components/github-connection";
import { GithubMark } from "@tuti/ui/github-mark";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { githubConfig } from "@/lib/github";
import { accountsFromCookie, ACCOUNTS_COOKIE } from "@/server/github-connect";
import { getAdminProject } from "@/server/membership";

export const metadata: Metadata = { title: "Integrations · Settings" };

/** What's on the way (docs/plan.md, Later), so a team sees it's coming. */
const COMING_SOON = [
  { name: "GitLab", icon: GitMergeIcon },
  { name: "Linear", icon: SquareKanbanIcon },
  { name: "Jira", icon: TicketIcon },
  { name: "Slack", icon: HashIcon },
];

/** GitHub's row, padded as a `SettingRow`. */
const ROW = "flex items-center gap-3 px-4 py-3.5 @min-[34rem]/settings:px-5";

const GITHUB_RESULTS: Record<string, string> = {
  disconnected: "GitHub disconnected.",
  expired: "That took too long. Try connecting again.",
  unconfirmed: "GitHub couldn't confirm that you can use that installation. Try connecting again.",
};

/** Settings → Integrations: GitHub (a row to connect it, or to its settings once connected), and the tools on the way as a line of tiles. */
export default async function IntegrationsSettingsPage(props: PageProps<"/app/[project]/settings/integrations">) {
  const { project: slug } = await props.params;
  const { github: githubResult } = await props.searchParams;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const github = githubConfig();
  // Back from "Connect GitHub" with the accounts the person has the app on.
  const accounts =
    githubResult === "choose" ? accountsFromCookie((await cookies()).get(ACCOUNTS_COOKIE)?.value ?? "", project.id) : [];
  const installation = await prisma.githubInstallation.findUnique({
    where: { projectId: project.id },
    select: { accountLogin: true, createdAt: true, project: { select: { analyseCodeChanges: true } } },
  });

  // As GitHub's own page: once connected, Autopilot reads pull requests only while the project has it on.
  const githubFor = codeChangesEnabled() && installation?.project.analyseCodeChanges !== false ? "Pull requests for the changelog and Autopilot" : "Pull requests for the changelog";

  return (
    <SettingsPane title="Integrations">
      {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
        <Alert variant={githubResult === "disconnected" ? "default" : "destructive"}>
          <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
        </Alert>
      )}
      <SettingsCard>
        {installation ? (
          <Link href={`/app/${project.slug}/settings/integrations/github`} className={cn(ROW, "rounded-xl transition-colors hover:bg-muted/50")}>
            <GithubMark className="size-6 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium wrap-anywhere">GitHub · {installation.accountLogin}</span>
              <span className="text-sm text-muted-foreground">{githubFor}</span>
            </span>
            <Badge title={`Connected ${formatDate(installation.createdAt)}`}>Connected</Badge>
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        ) : (
          <>
            <div className={ROW}>
              <GithubMark className="size-6 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col">
                <h2 className="font-medium">GitHub</h2>
                <p className="text-sm text-muted-foreground">{githubFor}</p>
              </div>
              {github && accounts.length === 0 && (
                <a
                  href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`}
                  className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
                  aria-label="Connect GitHub"
                >
                  Connect
                  <ChevronRightIcon />
                </a>
              )}
            </div>
            {!github ? (
              <SettingBlock className="text-sm text-muted-foreground">
                <p>GitHub isn&apos;t set up on this server (see GITHUB_APP_* in .env.example).</p>
              </SettingBlock>
            ) : (
              (accounts.length > 0 || codeChangesEnabled()) && (
                <SettingBlock className="text-sm">
                  {accounts.length > 0 && <GithubAccountChoice projectSlug={project.slug} accounts={accounts} />}
                  {/* What leaves the server once it's connected, said before connecting. */}
                  {codeChangesEnabled() && (
                    <p className="text-muted-foreground">
                      Tuti sends each merged pull request&apos;s diff, without secrets, to {aiProvider()} to propose the feedback it resolves and the docs it
                      changes, and the repository&apos;s files when Verify checks an article against them. You can turn that off once it&apos;s connected.
                    </p>
                  )}
                </SettingBlock>
              )
            )}
          </>
        )}
      </SettingsCard>
      <section aria-labelledby="soon-heading" className="@container flex flex-col gap-2">
        <h2 id="soon-heading" className="text-base font-semibold">
          Coming soon
        </h2>
        <ul className="grid grid-cols-2 gap-2 @min-[34rem]:grid-cols-4">
          {COMING_SOON.map(({ name, icon: Icon }) => (
            <li key={name} className="flex min-w-0 items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 font-medium">
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <Badge variant="secondary">Soon</Badge>
            </li>
          ))}
        </ul>
      </section>
    </SettingsPane>
  );
}
