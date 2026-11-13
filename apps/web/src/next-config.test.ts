import { PHASE_PRODUCTION_SERVER } from "next/constants";
import { expect, test } from "vitest";

import nextConfig from "../next.config";

test("browsers get the pages' metadata in the head as sent, not streamed after the page (where it could be added twice)", () => {
  const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  expect(nextConfig(PHASE_PRODUCTION_SERVER).htmlLimitedBots?.test(chrome)).toBe(true);
});
