import { aiEnabled, aiProvider, listModels, log } from "@tuti/shared";
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
  const [models, listed] = await Promise.all([
    aiModels(project.id),
    // Only suggestions: without them a model id can still be typed (and is checked when saved).
    listModels().catch((error: unknown) => {
      log.warn("Listing the AI models failed", { projectId: project.id, error });
      return [];
    }),
  ]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI models</CardTitle>
        <CardDescription>
          Which model writes for each AI feature, from the models at {aiProvider()}. Leave one empty to use the default. A bigger model can write better and costs more.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AiModelsSettings projectSlug={slug} models={models} listed={listed} />
      </CardContent>
    </Card>
  );
}
