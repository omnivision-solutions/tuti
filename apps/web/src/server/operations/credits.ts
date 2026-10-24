import { creditBalance } from "@tuti/jobs";
import { creditsEnabled } from "@tuti/shared";
import { z } from "zod";

import { defineOperation } from "./define";

export const getCredits = defineOperation({
  name: "credits.get",
  summary:
    "The project's AI credits, on a server that uses them (`enabled`): the balance (below 0 when a request ran past it; the next credits cover that first) and each grant with credits left, soonest-expiring first (`expiresAt` null: for good)",
  method: "GET",
  path: "/credits",
  scope: "read",
  access: "admin",
  input: z.object({}),
  run: async ({ projectId }) => (creditsEnabled() ? { enabled: true, ...(await creditBalance(projectId)) } : { enabled: false, balance: 0, grants: [] }),
});
