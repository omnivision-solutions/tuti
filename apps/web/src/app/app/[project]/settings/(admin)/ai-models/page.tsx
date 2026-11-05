import { aiEnabled, aiProvider, creditsEnabled, creditsPerUsageDollar, listModels, log, modelMaxPrice, TUNING, TUNING_KEYS, withinModelCap } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelsSettings } from "@/components/ai-models-settings";
import { CodeChangesTuningSettings } from "@/components/code-changes-tuning";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/format";
import { getMembership, isAdminRole } from "@/server/membership";
import { aiModels } from "@/server/operations/ai-models";
import { codeChangesTuning } from "@/server/operations/code-changes-tuning";

/** Settings → AI models: which model writes for each AI feature and each of Autopilot's steps, and Autopilot's Advanced tuning (only where the server has AI). */
export default async function AiModelsSettingsPage(props: PageProps<"/app/[project]/settings/ai-models">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !aiEnabled()) {
    notFound();
  }
  const { project } = membership;
  const [models, tuning, all] = await Promise.all([
    aiModels(project.id),
    codeChangesTuning(project.id),
    listModels().catch((error: unknown) => {
      log.warn("Listing the AI models failed", { projectId: project.id, error });
      return [];
    }),
  ]);
  // Only suggestions: without them a model id can still be typed (and is checked when saved).
  const listed = all.filter(withinModelCap);
  const cap = modelMaxPrice();
  const kept = Object.values(tuning.values).some((value) => value.saved !== null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI models</CardTitle>
        <CardDescription>
          Which model writes for each AI feature, from the models at {aiProvider()}. Fast is the default; a bigger model can write better and
          costs more (estimates for a typical use).
          {cap !== null && ` This server allows models up to $${cap} per million output tokens.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AiModelsSettings projectSlug={slug} models={models} listed={listed} creditsPerDollar={creditsEnabled() ? creditsPerUsageDollar() : null}>
          <CodeChangesTuningSettings
            projectSlug={slug}
            tuning={tuning}
            rows={TUNING_KEYS.map((key) => ({ key, label: TUNING[key].label, tradeoff: TUNING[key].tradeoff }))}
            owner={membership.role === "OWNER"}
            lastChanged={tuning.updatedAt && `${tuning.updatedBy ? `by ${tuning.updatedBy} ` : ""}${timeAgo(new Date(tuning.updatedAt))}`}
            notice={
              !tuning.available && (
                <PlanNotice feature="aiTuning" projectSlug={slug} admin>
                  {kept && "This project's values are kept but not used; back on Business, they're used again."}
                </PlanNotice>
              )
            }
          />
        </AiModelsSettings>
      </CardContent>
    </Card>
  );
}
