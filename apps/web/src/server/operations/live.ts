import { z } from "zod";

import { defineOperation } from "./define";

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
