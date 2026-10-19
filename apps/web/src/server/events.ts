import { emitEvent as emit } from "@tuti/jobs";

import type { WebhookEvent } from "@/lib/webhook-events";

/** Tells the project's webhooks about an event (see @tuti/jobs `emitEvent`), typed to the events settings offer. */
export const emitEvent = (
  projectId: string,
  type: WebhookEvent | "ping",
  data: Record<string, unknown>,
  options?: { only?: string },
) => emit(projectId, type, data, options);
