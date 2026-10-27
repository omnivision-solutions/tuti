import { prisma } from "@tuti/db";
import { z } from "zod";

import { defineOperation } from "./define";

/** The support inbox's settings (Settings → Support; docs/plan.md, Support inbox). */

const settings = async (projectId: string) => {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true } });
  return { inbox: project.supportInbox };
};

export const getSupportSettings = defineOperation({
  name: "support.get",
  summary: "Get the support inbox's settings: whether it's on (Messages in the widget; \"Ask a person\" starts a conversation)",
  method: "GET",
  path: "/support",
  scope: "read",
  access: "team",
  input: z.object({}),
  run: async ({ projectId }) => settings(projectId),
});

export const updateSupportSettings = defineOperation({
  name: "support.update",
  summary: "Turn the support inbox on or off",
  method: "PATCH",
  path: "/support",
  scope: "write",
  access: "admin",
  input: z.object({ inbox: z.boolean() }),
  example: { inbox: true },
  run: async ({ projectId }, input) => {
    await prisma.project.update({ where: { id: projectId }, data: { supportInbox: input.inbox } });
    return settings(projectId);
  },
});
