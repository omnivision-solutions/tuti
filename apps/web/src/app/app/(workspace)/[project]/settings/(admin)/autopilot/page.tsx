import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { codeChangesEnabled, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { AdvancedTuningLink, AutopilotChecksSwitch, AutopilotRecipientsForm, AutopilotSettingsForm, AutopilotSwitches } from "@/components/autopilot-settings";
import { CodeChangeSwitch } from "@/components/github-connection";
import { PlanNotice } from "@/components/plan-notice";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { aiModelSetting } from "@/lib/ai-model-setting";
import { autopilotRecordText } from "@/lib/autopilot-words";
import { upgradePrompt } from "@/lib/upgrade-prompt";
import { getMembership, isAdminRole } from "@/server/membership";
import { autopilotRecord } from "@/server/operations/code-changes";

export const metadata: Metadata = { title: "Autopilot · Settings" };

/**
 * Settings → AI → Autopilot: its AI model (Decides, Checks, Writes), whether Checks run and the way to Advanced tuning,
 * which owners and admins change; then whether it reads merged pull requests, what it does by itself, and how it's
 * doing, which owners change and admins see. Only where the server has AI.
 */
export default async function AutopilotSettingsPage(props: PageProps<"/app/[project]/settings/autopilot">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !codeChangesEnabled()) {
    notFound();
  }
  const owner = membership.role === "OWNER";
  const [model, team, project, github, record] = await Promise.all([
    aiModelSetting(membership.project, "code_changes", { code_changes_decide: "Decides", code_changes_check: "Checks", code_changes: "Writes" }),
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
  const checks = model.roles.find(({ role }) => role === "code_changes_check")!;
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
      {!owner && <p className="text-sm text-muted-foreground">Only owners change Autopilot&apos;s settings. Admins can change its AI model and Checks.</p>}
      {!planIncludes(project.plan, "codeChanges") && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin>
          Merged pull requests still go into the changelog&apos;s running draft.
        </PlanNotice>
      )}
      <SettingsCard>
        <AiModelSetting {...model} />
        {/* Off is the role's model saved as "off", on every level and plan. Where the server itself runs no checks, there's nothing to switch (unless a saved Off is still to undo). */}
        {(checks.default !== "off" || checks.model === "off") && <AutopilotChecksSwitch projectSlug={slug} on={checks.model !== "off"} />}
        <AdvancedTuningLink href={`/app/${slug}/settings/ai-models/tuning`} upgrade={planIncludes(project.plan, "aiTuning") ? null : upgradePrompt("aiTuning", slug, true)} />
      </SettingsCard>
      <SettingsCard>
        <CodeChangeSwitch projectSlug={slug} setting="analysis" on={project.analyseCodeChanges} owner={owner} />
      </SettingsCard>
      {project.analyseCodeChanges && (
        <SettingsCard title="What it does by itself">
          <CodeChangeSwitch projectSlug={slug} setting="autoLinks" on={project.autoApplyLinks} owner={owner} />
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
          <SettingBlock>
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
