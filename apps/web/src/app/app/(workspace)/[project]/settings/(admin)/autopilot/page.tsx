import { prisma } from "@tuti/db";
import { aiProvider, codeChangesEnabled, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AutopilotRecipientsForm, AutopilotSettingsForm, AutopilotSwitches } from "@/components/autopilot-settings";
import { CodeChangeSwitch } from "@/components/github-connection";
import { PlanNotice } from "@/components/plan-notice";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { autopilotRecordText } from "@/lib/autopilot-words";
import { getMembership, isAdminRole } from "@/server/membership";
import { autopilotRecord } from "@/server/operations/code-changes";

/**
 * Settings → AI → Autopilot: whether it reads merged pull requests (and what's sent where), what it does
 * by itself, and how it's doing. Owners change it; admins see it. Only where the server has AI.
 */
export default async function AutopilotSettingsPage(props: PageProps<"/app/[project]/settings/autopilot">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !codeChangesEnabled()) {
    notFound();
  }
  const owner = membership.role === "OWNER";
  const [team, project, github, record] = await Promise.all([
    prisma.teamMember.findMany({
      where: { projectId: membership.project.id, role: { not: "OWNER" } },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true, autopilotTold: true, user: { select: { name: true } } },
    }),
    prisma.project.findUniqueOrThrow({
      where: { id: membership.project.id },
      select: {
        analyseCodeChanges: true,
        autoApplyLinks: true,
        plan: true,
        autopilotDrafts: true,
        autopilotArticleEdits: true,
        autopilotProgress: true,
        autopilotComplete: true,
        autopilotMinSure: true,
        autopilotMaxReach: true,
        autopilotMaxViews: true,
        autopilotHoldHours: true,
        autopilotTellAdmins: true,
      },
    }),
    prisma.githubInstallation.findUnique({ where: { projectId: membership.project.id }, select: { projectId: true } }),
    autopilotRecord(membership.project.id),
  ]);
  return (
    <SettingsPane
      title="Autopilot"
      description={
        <>
          When a pull request merges, Autopilot reads it and finds the posts it completes, the docs it changes and its changelog line.{" "}
          {!github && (
            <>
              It reads the repositories you add in{" "}
              <Link href={`/app/${slug}/settings/integrations`} className="underline">
                Integrations
              </Link>
              .
            </>
          )}
        </>
      }
    >
      {!owner && <p className="text-sm text-muted-foreground">Only owners change Autopilot&apos;s settings.</p>}
      {!planIncludes(project.plan, "codeChanges") && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin>
          Merged pull requests still go into the changelog&apos;s running draft.
        </PlanNotice>
      )}
      <SettingsCard>
        <SettingBlock>
          <CodeChangeSwitch projectSlug={slug} setting="analysis" on={project.analyseCodeChanges} provider={aiProvider()} owner={owner} />
        </SettingBlock>
      </SettingsCard>
      {project.analyseCodeChanges && (
        <SettingsCard title="What it does by itself">
          <SettingBlock className="gap-6">
            <CodeChangeSwitch projectSlug={slug} setting="autoLinks" on={project.autoApplyLinks} provider={aiProvider()} owner={owner} />
            <AutopilotSwitches
              projectSlug={slug}
              owner={owner}
              settings={{
                drafts: project.autopilotDrafts,
                articleEdits: project.autopilotArticleEdits,
                progress: project.autopilotProgress,
                complete: project.autopilotComplete,
              }}
            />
            <AutopilotSettingsForm
              projectSlug={slug}
              owner={owner}
              settings={{
                minSure: project.autopilotMinSure,
                maxReach: project.autopilotMaxReach,
                maxViews: project.autopilotMaxViews,
                holdHours: project.autopilotHoldHours,
              }}
            />
          </SettingBlock>
        </SettingsCard>
      )}
      {project.analyseCodeChanges && (
        <SettingsCard
          title="Who's told"
          description="Owners and the people below get emails about merged pull requests, as often as each picks in their account settings. Owners always hear when something customers see goes out by itself."
        >
          <SettingBlock>
            <AutopilotRecipientsForm
              projectSlug={slug}
              owner={owner}
              admins={project.autopilotTellAdmins}
              members={team.map((member) => ({ userId: member.userId, name: member.user.name, role: member.role as "ADMIN" | "MEMBER", told: member.autopilotTold }))}
            />
          </SettingBlock>
        </SettingsCard>
      )}
      <SettingsCard title="How it's doing">
        <SettingBlock>
          <p className="text-sm text-muted-foreground">{autopilotRecordText(record)}</p>
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
