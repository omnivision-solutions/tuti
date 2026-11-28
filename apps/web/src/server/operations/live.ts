import { prisma } from "@tuti/db";
import { z } from "zod";

import { canActIn } from "../membership";
import { listener } from "../widget-person";
import { defineOperation, OperationError } from "./define";

/**
 * The team's live stream (/api/live): whether the caller may hear a project's Inbox changes, and which project's they
 * are. Asked when the stream opens and at each keepalive after (server/live.ts), so it ends once they leave the team.
 */
export const getInboxLive = defineOperation({
  name: "live.inbox",
  title: "Hear Inbox changes",
  summary: "Whether the caller may hear the project's live Inbox changes: its team.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "team",
  input: z.object({}),
  output: z.object({ projectId: z.string() }),
  run: async ({ projectId }) => ({ projectId }),
});

/**
 * The widget's live stream for Messages (/api/widget/live): who hears, and only their own conversations' changes (hears).
 * Someone the customer's site signed in (the widget's token), someone signed in on the portal itself (who may act in the
 * project), or a signed-out visitor by their token; nobody else. Anyone who can read the portal, as the panel itself:
 * asked when the stream opens and at each keepalive, so it ends once their token or session does.
 */
export const getWidgetLive = defineOperation({
  name: "live.widget",
  title: "Hear Messages changes",
  summary: "Who hears the widget's live Messages changes: the widget's person, the portal's signed-in reader, or a visitor.",
  method: "GET",
  internal: true,
  scope: "read",
  access: "reader",
  errors: [404],
  input: z.object({}),
  output: z.object({ projectId: z.string(), userId: z.string().nullable(), visitorHash: z.string().nullable(), email: z.string().nullable() }),
  run: async ({ actor, projectId }) => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { supportInbox: true } });
    if (!project.supportInbox) {
      throw new OperationError(404, "not_found", "Messages are off for this project");
    }
    if (actor.kind === "visitor") {
      if (!actor.visitorHash) {
        throw new OperationError(401, "unauthorized", "Sign in to message the team");
      }
      return listener(projectId, { visitorHash: actor.visitorHash });
    }
    if (actor.kind !== "user") {
      throw new OperationError(403, "people_only", "Only the widget's person hears their Messages");
    }
    // Signed in on the portal itself (not by the widget's token): only while they may act in the project.
    if (!actor.viaWidget && !(await canActIn(actor.userId, projectId))) {
      throw new OperationError(403, "forbidden", "You can't do this in this project");
    }
    return listener(projectId, { userId: actor.userId });
  },
});
