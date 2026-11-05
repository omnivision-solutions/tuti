import { aiEnabled, aiProvider, codeChangesSettings, creditsEnabled, creditsPerUsageDollar, listModels, log, modelMaxPrice, withinModelCap } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AiModelsSettings } from "@/components/ai-models-settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAdminProject } from "@/server/membership";
import { aiModels } from "@/server/operations/ai-models";

/** Settings → AI models: which model writes for each AI feature (only where the server has AI). */
export default async function AiModelsSettingsPage(props: PageProps<"/app/[project]/settings/ai-models">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !aiEnabled()) {
    notFound();
  }
  const [models, all] = await Promise.all([
    aiModels(project.id),
    listModels().catch((error: unknown) => {
      log.warn("Listing the AI models failed", { projectId: project.id, error });
      return [];
    }),
  ]);
  // Only suggestions: without them a model id can still be typed (and is checked when saved).
  const listed = all.filter(withinModelCap);
  // A merged pull request is priced with Autopilot's docs agent deciding too (its model is a server setting, not a pick).
  const docsAgent = all.find((model) => model.id === codeChangesSettings().decide.model) ?? null;
  const cap = modelMaxPrice();
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
        <AiModelsSettings
          projectSlug={slug}
          models={models}
          listed={listed}
          creditsPerDollar={creditsEnabled() ? creditsPerUsageDollar() : null}
          docsAgent={docsAgent}
        />
      </CardContent>
    </Card>
  );
}
