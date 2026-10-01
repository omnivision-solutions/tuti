import { HatchetClient } from "@hatchet-dev/typescript-sdk";

import { jobs, type JobInput, type JobKey } from "./jobs";

let client: HatchetClient | undefined;

/**
 * Lazily created so importing this module never needs Hatchet credentials
 * (e.g. during `next build`). Reads HATCHET_CLIENT_* env vars.
 */
export function getHatchet(): HatchetClient {
  client ??= HatchetClient.init();
  return client;
}

/** Enqueue a background job without waiting for its result. */
export async function enqueue<K extends JobKey>(key: K, input: JobInput<K>) {
  const job = jobs[key];
  return getHatchet().runNoWait(job.name, job.input.parse(input));
}
