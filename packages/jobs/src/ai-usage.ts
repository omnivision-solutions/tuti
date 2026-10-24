import { prisma } from "@tuti/db";
import { type AiUsage, log, type Meter } from "@tuti/shared";

/** What an AI request was for, as Settings → Usage groups a project's spend. */
export type AiFeature = "answers" | "escalations" | "changelog" | "code_changes" | "duplicates" | "search" | "docs_index";

/**
 * A Meter that records each answered request for `projectId` (docs/plan.md, AI usage per project).
 * A failed write is logged, never thrown: the feature already has its answer.
 */
export function meter(projectId: string, feature: AiFeature): Meter {
  return async (usage: AiUsage) => {
    try {
      await prisma.aiUsage.create({ data: { projectId, feature, ...usage } });
    } catch (error) {
      log.error("Recording AI usage failed", { projectId, feature, kind: usage.kind, error });
    }
  };
}
