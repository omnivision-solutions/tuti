import { z } from "zod";

/**
 * Background job contracts shared by the web app (which enqueues) and the
 * worker (which implements). Keeping only names + input schemas here means the
 * web bundle never pulls in worker code.
 */
export const jobs = {
  postCreated: {
    name: "post-created",
    input: z.object({
      workspaceId: z.string(),
      postId: z.string(),
    }),
  },
} as const;

export type JobKey = keyof typeof jobs;
export type JobInput<K extends JobKey> = z.infer<(typeof jobs)[K]["input"]>;
