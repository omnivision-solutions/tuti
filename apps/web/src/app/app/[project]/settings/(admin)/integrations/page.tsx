import { prisma } from "@tuti/db";
import { aiProvider, codeChangesEnabled } from "@tuti/shared";
import { ChevronRightIcon, GitMergeIcon, HashIcon, SquareKanbanIcon, TicketIcon } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { GithubAccountChoice } from "@/components/github-connection";
import { GithubMark } from "@/components/github-mark";
import { IntegrationLogo } from "@/components/integration-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, timeAgo } from "@/lib/format";
import { githubConfig } from "@/lib/github";
import { accountsFromCookie, ACCOUNTS_COOKIE } from "@/server/github-connect";
import { getAdminProject } from "@/server/membership";

/** What's on the way (docs/plan.md, Later), so a team sees it's coming. */
const COMING_SOON = [
  { name: "GitLab", icon: GitMergeIcon, text: "Merge requests in the changelog and Autopilot, like GitHub's pull requests." },
  { name: "Linear", icon: SquareKanbanIcon, text: "Issues linked to feedback, their progress shown on the post." },
  { name: "Jira", icon: TicketIcon, text: "Issues linked to feedback, their progress shown on the post." },
  { name: "Slack", icon: HashIcon, text: "New feedback, conversations and Autopilot's updates in a channel." },
];

const GITHUB_RESULTS: Record<string, string> = {
  disconnected: "GitHub disconnected.",
  expired: "That took too long. Try connecting again.",
  unconfirmed: "GitHub couldn't confirm that you can use that installation. Try connecting again.",
};

/** Settings → Integrations: the tools connected to the project (each with Manage), the ones to connect, and the ones on the way. */
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
    select: { accountLogin: true, createdAt: true },
  });

  return (
    <div className="flex flex-col gap-8">
      {typeof githubResult === "string" && GITHUB_RESULTS[githubResult] && (
        <Alert variant={githubResult === "disconnected" ? "default" : "destructive"}>
          <AlertDescription>{GITHUB_RESULTS[githubResult]}</AlertDescription>
        </Alert>
      )}
      {installation && (
        <section aria-labelledby="connected-heading" className="flex flex-col gap-3">
          <h2 id="connected-heading" className="font-heading text-base font-medium">
            Connected
          </h2>
          <Link
            href={`/app/${project.slug}/settings/integrations/github`}
            className="flex items-center gap-4 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50"
          >
            <IntegrationLogo>
              <GithubMark className="size-6" />
            </IntegrationLogo>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">GitHub · {installation.accountLogin}</span>
              <span className="text-sm text-muted-foreground" title={formatDate(installation.createdAt)}>
                Connected {timeAgo(installation.createdAt)}
              </span>
            </span>
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              Manage
              <ChevronRightIcon className="size-4" />
            </span>
          </Link>
        </section>
      )}
      {!installation && (
        <section aria-labelledby="connect-heading" className="flex flex-col gap-3">
          <h2 id="connect-heading" className="font-heading text-base font-medium">
            Connect a tool
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:col-span-2 [&:not(:has([data-choice]))]:sm:col-span-1">
              <IntegrationLogo>
                <GithubMark className="size-6" />
              </IntegrationLogo>
              <div className="flex flex-col gap-1">
                <h3 className="font-medium">GitHub</h3>
                <p className="text-sm text-muted-foreground">
                  Merged pull requests gather in the changelog&apos;s Next release draft.
                  {codeChangesEnabled() &&
                    ` Tuti also sends each one's diff, without secrets, to ${aiProvider()} to propose the feedback it resolves and the docs it changes. You can turn that off once it's connected.`}
                </p>
              </div>
              {!github ? (
                <p className="text-sm text-muted-foreground">GitHub isn&apos;t set up on this server (see GITHUB_APP_* in .env.example).</p>
              ) : accounts.length > 0 ? (
                <div data-choice className="text-sm">
                  <GithubAccountChoice projectSlug={project.slug} accounts={accounts} />
                </div>
              ) : (
                <a
                  href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`}
                  className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}
                  aria-label="Connect GitHub"
                >
                  Connect
                  <ChevronRightIcon />
                </a>
              )}
            </div>
          </div>
        </section>
      )}
      <section aria-labelledby="soon-heading" className="flex flex-col gap-3">
        <h2 id="soon-heading" className="font-heading text-base font-medium">
          Coming soon
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2">
          {COMING_SOON.map(({ name, icon: Icon, text }) => (
            <li key={name} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <IntegrationLogo>
                  <Icon aria-hidden className="size-5" />
                </IntegrationLogo>
                <Badge variant="secondary">Coming soon</Badge>
              </div>
              <div className="flex flex-col gap-1">
                <h3 className="font-medium">{name}</h3>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
