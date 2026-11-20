import type { Metadata } from "next";
import { aiEnabled, codeChangesEnabled, TUNING, TUNING_KEYS } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CodeChangesTuningSettings } from "@/components/code-changes-tuning";
import { PlanNotice } from "@/components/plan-notice";
import { timeAgo } from "@/lib/format";
import { getMembership, isAdminRole } from "@/server/membership";
import { codeChangesTuning } from "@/server/operations/code-changes-tuning";

export const metadata: Metadata = { title: "Tuning · Autopilot · Settings" };

/**
 * Settings → Autopilot → Advanced tuning: Autopilot's values for this project (owners change them, on a plan with Advanced tuning; admins
 * see them). A page of its own, so Settings → Autopilot and this each save one way.
 */
export default async function CodeChangesTuningPage(props: PageProps<"/app/[project]/settings/autopilot/tuning">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !aiEnabled()) {
    notFound();
  }
  const tuning = await codeChangesTuning(membership.project.id);
  const kept = Object.values(tuning.values).some((value) => value.saved !== null);
  return (
    <CodeChangesTuningSettings
      projectSlug={slug}
      tuning={tuning}
      labels={Object.fromEntries(TUNING_KEYS.map((key) => [key, TUNING[key].label])) as Record<(typeof TUNING_KEYS)[number], string>}
      // Back to Autopilot's settings; where the server has AI but can't run Autopilot (that page isn't there), to the first of the AI pages.
      back={codeChangesEnabled() ? { href: `/app/${slug}/settings/autopilot`, label: "Autopilot" } : { href: `/app/${slug}/settings/ai-answers`, label: "AI answers" }}
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
  );
}
