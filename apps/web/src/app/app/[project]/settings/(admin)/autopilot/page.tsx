import { prisma } from "@tuti/db";
import { aiProvider, codeChangesEnabled, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CodeChangeSwitch } from "@/components/github-connection";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getMembership } from "@/server/membership";
import { autopilotRecord } from "@/server/operations/code-changes";

/**
 * Settings → AI → Autopilot: whether it reads merged pull requests (and what's sent where), what it does
 * by itself, and how it's doing. Owners change it; admins see it. Only where the server has AI.
 */
export default async function AutopilotSettingsPage(props: PageProps<"/app/[project]/settings/autopilot">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !codeChangesEnabled()) {
    notFound();
  }
  const owner = membership.role === "OWNER";
  const [project, github, record] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { analyseCodeChanges: true, autoApplyLinks: true, plan: true } }),
    prisma.githubInstallation.findUnique({ where: { projectId: membership.project.id }, select: { projectId: true } }),
    autopilotRecord(membership.project.id),
  ]);
  return (
    <>
      {!owner && <p className="text-sm text-muted-foreground">Only owners change Autopilot&apos;s settings.</p>}
      {!planIncludes(project.plan, "codeChanges") && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin>
          Merged pull requests still go into the changelog&apos;s running draft.
        </PlanNotice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
          <CardDescription>
            When a pull request merges, Autopilot reads it and finds the requests it closes, the docs it changes and its changelog line.{" "}
            {github ? (
              "Nothing changes for your users until your team approves an update."
            ) : (
              <>
                It reads the repositories you add in{" "}
                <Link href={`/app/${slug}/settings/integrations`} className="underline">
                  Integrations
                </Link>
                .
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeChangeSwitch projectSlug={slug} setting="analysis" on={project.analyseCodeChanges} provider={aiProvider()} owner={owner} />
        </CardContent>
      </Card>
      {project.analyseCodeChanges && (
        <Card>
          <CardHeader>
            <CardTitle>What it does by itself</CardTitle>
          </CardHeader>
          <CardContent>
            <CodeChangeSwitch projectSlug={slug} setting="autoLinks" on={project.autoApplyLinks} provider={aiProvider()} owner={owner} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>How it&apos;s doing</CardTitle>
          <CardDescription>
            {record.of === 0
              ? record.wentOut
                ? "Nothing it can count yet: drafts finished in the editor, and updates approved before this was kept, aren't counted."
                : "Nothing has gone out yet. Once updates are approved, this says how many were kept as Autopilot wrote them."
              : `Kept ${record.kept} of its last ${record.of} ${record.of === 1 ? "update" : "updates"} unchanged: not edited before approving, nor undone since.`}
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
