import { z } from "zod";

/**
 * Screenshots (docs/plan.md, Screenshots): an agent in Browser Use's cloud browser signs in to a team's own app and
 * takes screenshots of it. Its key is BROWSER_USE_API_KEY (an env var: a secret); these are what an operator tunes.
 */
export const screenshots = z
  .strictObject({
    model: z.string().regex(/^\S{1,100}$/, "a Browser Use model id").describe("The agent's model, a Browser Use model id").default("bu-4.0-mini"),
    retryModel: z
      .string()
      .regex(/^\S{1,100}$/, "a Browser Use model id")
      .describe("The model a run is tried once more with when the first fails as a whole (not when a screenshot or two weren't reached)")
      .default("bu-4.0"),
    maxCostUsd: z.number().positive().max(100).describe("The most one run may cost, in dollars, its retry included: Browser Use stops it there (a number above 0, at most 100)").default(1),
  })
  .prefault({});
