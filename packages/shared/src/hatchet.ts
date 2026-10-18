import { HatchetClient } from "@hatchet-dev/typescript-sdk";

let client: HatchetClient | undefined;

/**
 * Lazily created so importing this module never needs Hatchet credentials
 * (e.g. during `next build`). Reads HATCHET_CLIENT_* env vars.
 */
export function getHatchet(): HatchetClient {
  client ??= HatchetClient.init();
  return client;
}

