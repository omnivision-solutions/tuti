import { z } from "zod";

/**
 * The spam filter's model checks (docs/plan.md, Inbox automation, "The spam filter", checks 6 and 7): a new conversation
 * no free check decided is asked of a decision model, then of a chat model where it wasn't sure. They're never charged
 * in credits, so a cap per project stops strangers running up the server's cost by sending mail.
 */
export const spam = z
  .strictObject({
    decisions: z
      .strictObject({
        model: z
          .string()
          .regex(/^\S{1,200}$/, "a model id, or off")
          .describe("Check 6: the decision model saying whether a new conversation is spam (at least 0.9 is, at most 0.3 isn't); OpenRouter only (elsewhere, and with `off`, check 7 alone)")
          .default("nace-ai/drex-max"),
      })
      .prefault({}),
    chat: z
      .strictObject({
        model: z
          .string()
          .regex(/^\S{1,200}$/, "a model id, or off")
          .nullable()
          .describe("Check 7: the chat model asked where the decision model wasn't sure (or without one): spam, not spam or unsure; `off` for none. Without, `ai.model`, then Tuti's default")
          .default(null),
      })
      .prefault({}),
    requestsPerDay: z
      .number()
      .int()
      .min(0)
      .max(100_000)
      .describe("The most model requests the spam filter makes for one project in a day (UTC); past it, new conversations go to the inbox unchecked. 0 turns the model checks off")
      .default(200),
  })
  .prefault({});
