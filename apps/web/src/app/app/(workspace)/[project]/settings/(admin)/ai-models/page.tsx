import { aiEnabled, creditsEnabled, creditsPerUsageDollar, listModels, log, modelMaxPrice, planIncludes, withinModelCap } from "@tuti/shared";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AiModelsSettings } from "@/components/ai-models-settings";
import { Badge } from "@/components/ui/badge";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { getMembership, isAdminRole } from "@/server/membership";
import { aiModels } from "@/server/operations/ai-models";

/** Settings → AI models: which model writes for each AI feature and each of Autopilot's steps, and the way to Autopilot's Advanced tuning (only where the server has AI). */
export default async function AiModelsSettingsPage(props: PageProps<"/app/[project]/settings/ai-models">) {
  const { project: slug } = await props.params;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role) || !aiEnabled()) {
    notFound();
  }
  const { project } = membership;
  const [models, all] = await Promise.all([
    aiModels(project.id),
    listModels().catch((error: unknown) => {
      log.warn("Listing the AI models failed", { projectId: project.id, error });
      return [];
    }),
  ]);
  // Only suggestions: without them a model id can still be typed (and is checked when saved).
  const listed = all.filter(withinModelCap);
  const cap = modelMaxPrice();
  return (
    <SettingsPane
      title="AI models"
      description={`Which model writes for each AI feature, from the models this server offers. Fast is the default; a bigger model can write better and costs more (estimates for a typical use).${cap !== null ? ` This server allows models up to $${cap} per million output tokens.` : ""}`}
    >
      <SettingsCard>
        <SettingBlock>
          <AiModelsSettings projectSlug={slug} models={models} listed={listed} creditsPerDollar={creditsEnabled() ? creditsPerUsageDollar() : null}>
            {/* Its own page, which saves its own way (one Save each). */}
            <Link
              href={`/app/${slug}/settings/ai-models/tuning`}
              className="flex items-center gap-3 rounded-xl border px-4 py-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2 font-medium">
                  Advanced tuning
                  {!planIncludes(project.plan, "aiTuning") && <Badge variant="outline">Available on Business</Badge>}
                </span>
                <span className="text-muted-foreground">How sure Autopilot must be, how much it looks up and thinks, for this project.</span>
              </span>
              <ChevronRightIcon className="size-4 text-muted-foreground" />
            </Link>
          </AiModelsSettings>
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
