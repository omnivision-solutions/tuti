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
    // Hatchet waits factor^n seconds before retry n, capped: 5s, 25s, 2m, 10m, 52m, 4.3h, 8h, 8h ≈ 21h in all.
    backoff: { factor: 5, maxSeconds: 8 * 60 * 60 },
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
