import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { checksOn } from "@tuti/jobs";
import { aiProvider, codeChangesEnabled, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AiModelSetting } from "@/components/ai-model-setting";
import { AdvancedTuningLink, AutopilotChecksNotice, AutopilotChecksSwitch, AutopilotRecipientsForm, AutopilotSettingsForm, AutopilotSwitches } from "@/components/autopilot-settings";
import { CodeChangeSwitch } from "@/components/github-connection";
import { PlanNotice } from "@/components/plan-notice";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { aiModelSetting, checksSwitch } from "@/lib/ai-model-setting";
import { autopilotRecordText, checksNoticeShown } from "@/lib/autopilot-words";
import { costLabel, costPerUse } from "@/lib/model-tiers";
import { upgradePrompt } from "@/lib/upgrade-prompt";
import { getMembership, isAdminRole } from "@/server/membership";
import { autopilotRecord } from "@/server/operations/code-changes";
import { codeChangesTuning } from "@/server/operations/code-changes-tuning";

export const metadata: Metadata = { title: "Autopilot · Settings" };

/**
 * Settings → AI → Autopilot: its AI model (Decides, Checks, Writes), whether Checks run and the way to Advanced tuning,
 * which owners and admins change; then whether it reads merged pull requests (and what's sent where), what it does by itself, and how it's
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
        autopilotChecksNoticeDismissed: true,
      },
    }),
    prisma.githubInstallation.findUnique({ where: { projectId: membership.project.id }, select: { projectId: true } }),
    autopilotRecord(membership.project.id),
  ]);
  const checks = checksSwitch(model);
  // Where the server checks this project's article edits (docs/plan.md, E5): the switch says what it does and prices a
  // review, and with Checks off a notice says edits wait (checksNoticeShown), until it's on or dismissed.
  const reviews = checks && checksOn(slug) ? { price: costLabel(costPerUse("edit_review", model.listed.find((listed) => listed.id === checks.model)), model.creditsPerDollar) } : undefined;
  const notice = checksNoticeShown({
    reviewed: Boolean(reviews),
    checks: checks?.on ?? false,
    planHasIt: planIncludes(project.plan, "codeChanges"),
    analyses: project.analyseCodeChanges,
    publishesEdits: project.autopilotArticleEdits,
    dismissed: project.autopilotChecksNoticeDismissed,
  });
  const tuning = `/app/${slug}/settings/autopilot/tuning`;
  const tunable = planIncludes(project.plan, "aiTuning");
  // Values saved on a plan that had tuning, kept and not used on this one (the tuning page's own test): the row opens
  // the upgrade prompt, so a link under the card is the way to see them.
  const kept = !tunable && Object.values((await codeChangesTuning(membership.project.id)).values).some((value) => value.saved !== null);
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
      {notice && <AutopilotChecksNotice projectSlug={slug} />}
      {!owner && <p className="text-sm text-muted-foreground">Only owners change Autopilot&apos;s settings. Admins can change its AI model and Checks.</p>}
      {!planIncludes(project.plan, "codeChanges") && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin>
          Merged pull requests still go into the changelog&apos;s running draft.
        </PlanNotice>
      )}
      <div className="flex flex-col gap-2">
        <SettingsCard>
          {/* Without the switch (this server runs no checks), a saved Off is Custom's empty box, where a model can be picked, not a row that only the switch could change. */}
          <AiModelSetting {...model} roles={checks ? model.roles : model.roles.map((role) => (role.model === "off" ? { ...role, model: "" } : role))} />
          {checks && <AutopilotChecksSwitch projectSlug={slug} on={checks.on} reviews={reviews} />}
          <AdvancedTuningLink href={tuning} upgrade={tunable ? null : upgradePrompt("aiTuning", slug, true)} />
        </SettingsCard>
        {kept && (
          <p className="text-sm text-muted-foreground">
            <Link href={tuning} className="underline underline-offset-4">
              See saved tuning values
            </Link>
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <SettingsCard>
          <CodeChangeSwitch projectSlug={slug} setting="analysis" on={project.analyseCodeChanges} owner={owner} />
        </SettingsCard>
        {/* What leaves, said where it's switched on (docs/plan.md: the team knows what's sent where). The page's, not a hint of the switch's. */}
        <p className="text-sm text-muted-foreground">
          Sent to {aiProvider()}: each merged pull request&apos;s title, description, commits and diff, the repository files Autopilot reads at its merge commit
          and your help center&apos;s articles and drafts (to find what to fix), and the files Verify reads when it checks an article. Lockfiles, generated
          files and files that hold secrets (like .env and keys) are left out, and secret-looking strings are masked.
        </p>
      </div>
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
