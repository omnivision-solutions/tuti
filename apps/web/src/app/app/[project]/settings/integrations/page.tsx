import { prisma } from "@tuti/db";
import { notFound } from "next/navigation";

import { CloseOnSelect, DisconnectGithubButton, PrCommentsCheckbox } from "@/components/github-connection";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { githubConfig } from "@/lib/github";
import { getAdminProject } from "@/server/membership";

const GITHUB_RESULTS: Record<string, string> = {
  connected: "GitHub is connected.",
  unconfirmed: "GitHub couldn't confirm that you can use that installation. Try connecting again.",
  taken: "That GitHub account is already connected to another project.",
};

/** Settings → Integrations: GitHub (pull requests that link posts, move and complete them). */
export default async function IntegrationsSettingsPage(props: PageProps<"/app/[project]/settings/integrations">) {
  const { project: slug } = await props.params;
  const { github: githubResult } = await props.searchParams;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const github = githubConfig();
  const installation = await prisma.githubInstallation.findUnique({
    where: { projectId: project.id },
    select: { accountLogin: true, closeOn: true, commentOnPullRequests: true },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
        <CardDescription>
          Pull requests that mention a post (tuti#12, or the post&apos;s link) link to it and move it to In progress; shipping them completes it.
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
          <a href={`/api/github/install?${new URLSearchParams({ project: project.slug })}`} className={buttonVariants({ className: "self-start" })}>
            Connect GitHub
          </a>
        )}
      </CardContent>
    </Card>
  );
}
