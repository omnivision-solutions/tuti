import { z } from "zod";

/**
 * Background job contracts shared by the web app (which enqueues) and the
 * worker (which implements). Keeping only names + input schemas here means the
 * web bundle never pulls in worker code.
 */
type JobOptions = {
  name: string;
  input: z.ZodType;
  /** Run on this schedule (cron syntax) instead of being enqueued. */
  cron?: string;
  /** Hatchet retries (default 3) and their backoff. */
  retries?: number;
  backoff?: { factor: number; maxSeconds: number };
};

export const jobs = {
  postCreated: {
    name: "post-created",
    input: z.object({
      projectId: z.string(),
      postId: z.string(),
    }),
  },
  imageUploaded: {
    name: "image-uploaded",
    input: z.object({ mediaId: z.string() }),
  },
  /** Sends one webhook delivery; retried with backoff for about a day (at-least-once). */
  webhookDelivery: {
    name: "webhook-delivery",
    input: z.object({ deliveryId: z.string() }),
    retries: 8,
    backoff: { factor: 3, maxSeconds: 4 * 60 * 60 },
  },
  /** Runs on a schedule (the worker registers `cron`), not enqueued. */
  cleanupMedia: {
    name: "cleanup-media",
    input: z.object({}),
    cron: "17 * * * *",
  },
} as const satisfies Record<string, JobOptions>;

export type JobKey = keyof typeof jobs;
export type JobInput<K extends JobKey> = z.infer<(typeof jobs)[K]["input"]>;
