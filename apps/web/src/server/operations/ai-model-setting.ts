import { prisma } from "@tuti/db";
import { AI_GROUP_NAMES, AI_LEVELS, type PlanKey } from "@tuti/shared";
import { z } from "zod";

import { aiModelSetting, ROLE_LABELS } from "@/lib/ai-model-setting";

import { defineOperation } from "./define";

const level = z.enum(AI_LEVELS);

/**
 * A settings page's "AI model" setting for one group of roles (AiModelSetting, lib/ai-model-setting.ts), page-shaped
 * (internal): the levels and their upgrade prompts, the models in use, and the endpoint's models to pick from.
 */
export const getAiModelSetting = defineOperation({
  name: "aiModels.setting",
  title: "Get an AI model setting",
  summary: "What a settings page's AI model setting shows for one group of roles: the level saved and in use, each role's model, and the models to pick from.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "admin",
  input: z.object({ group: z.enum(AI_GROUP_NAMES as [string, ...string[]]) }),
  // ponytail: the upgrade prompts and the endpoint's model list are typed by run (lib/ai-model-setting.ts), not spelled out here.
  output: z.object({
    projectSlug: z.string(),
    group: z.string(),
    saved: level,
    used: level,
    levels: z.array(z.object({ level, name: z.string(), upgrade: z.unknown() })),
    summary: z.string(),
    notice: z.string().nullable(),
    roles: z.array(z.object({ role: z.string(), label: z.string(), model: z.string(), default: z.string(), used: z.string(), agent: z.boolean() })),
    listed: z.array(z.unknown()),
    creditsPerDollar: z.number().nullable(),
  }),
  run: async ({ projectId }, { group }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true, slug: true, plan: true } });
    const key = group as keyof typeof ROLE_LABELS;
    // The group's own labels (ROLE_LABELS is keyed by group, which TypeScript can't follow through a variable key).
    return aiModelSetting({ ...project, plan: project.plan as PlanKey }, key, ROLE_LABELS[key] as never);
  },
});
