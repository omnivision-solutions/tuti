/**
 * Cuts the quotes from email messages imported from Featurebase before imports cut them; each whole email stays
 * behind "Show the whole email". Run once, after the release that cuts them is out, with when it went out (imports
 * since then are left as they are): pnpm --filter @tuti/worker cut:imported-quotes 2026-11-06T19:00:00Z
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { cutImportedQuotes } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

const released = new Date(process.argv[2] ?? "");
if (Number.isNaN(released.getTime())) {
  console.error("Say when the release that cuts imported quotes went out, e.g. cut:imported-quotes 2026-11-06T19:00:00Z");
  process.exit(1);
}
console.log(`cut the quotes from ${await cutImportedQuotes(released)} imported email message(s)`);
await prisma.$disconnect();
