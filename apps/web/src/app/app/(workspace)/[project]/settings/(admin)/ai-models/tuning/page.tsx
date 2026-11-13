import { aiEnabled, TUNING, TUNING_KEYS } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CodeChangesTuningSettings } from "@/components/code-changes-tuning";
import { PlanNotice } from "@/components/plan-notice";
import { SettingsPane } from "@/components/settings-card";
import { timeAgo } from "@/lib/format";
import { getMembership, isAdminRole } from "@/server/membership";
import { codeChangesTuning } from "@/server/operations/code-changes-tuning";

/**
 * Settings → AI models → Advanced tuning: Autopilot's values for this project (owners change them, on Business; admins
 * see them). A page of its own, so Settings → AI models and this each save one way.
 */
export default async function CodeChangesTuningPage(props: PageProps<"/app/[project]/settings/ai-models/tuning">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !aiEnabled()) {
    notFound();
  }
  const tuning = await codeChangesTuning(membership.project.id);
  const kept = Object.values(tuning.values).some((value) => value.saved !== null);
  return (
    <SettingsPane title="Advanced tuning" back={{ href: `/app/${slug}/settings/ai-models`, label: "AI models" }}>
      <CodeChangesTuningSettings
        projectSlug={slug}
        tuning={tuning}
        rows={TUNING_KEYS.map((key) => ({ key, label: TUNING[key].label, tradeoff: TUNING[key].tradeoff }))}
        owner={membership.role === "OWNER"}
        lastChanged={tuning.updatedAt && `${tuning.updatedBy ? `by ${tuning.updatedBy} ` : ""}${timeAgo(new Date(tuning.updatedAt))}`}
        notice={
          !tuning.available && (
            <PlanNotice feature="aiTuning" projectSlug={slug} admin>
              {kept && "This project's values are kept but not used; on a plan with Advanced tuning, they're used again."}
            </PlanNotice>
          )
        }
      />
    </SettingsPane>
  );
}
