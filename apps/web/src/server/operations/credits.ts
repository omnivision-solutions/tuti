import { aiFor, creditBalance, OutOfCredits } from "@tuti/jobs";
import { type Ai, type AiFeature, creditsEnabled } from "@tuti/shared";
import { z } from "zod";

import { defineOperation, OperationError } from "./define";

/** What the team is told when the project's AI is paused for want of credits. */
export const NO_CREDITS = "This project is out of AI credits. See Settings → Billing.";

/** aiFor, for an operation a team member is waiting on: out of AI credits, it's refused (402) with the reason. */
export async function aiOrRefuse(projectId: string, feature: AiFeature): Promise<Ai> {
  try {
    return await aiFor(projectId, feature);
  } catch (error) {
    if (error instanceof OutOfCredits) {
      throw new OperationError(402, "no_credits", NO_CREDITS);
    }
    throw error;
  }
}

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
