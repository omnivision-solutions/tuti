/**
 * Cuts the quotes from email messages imported from Featurebase before imports cut them; each whole email stays
 * behind "Show the whole email". Run once: pnpm --filter @tuti/worker cut:imported-quotes
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { cutImportedQuotes } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

console.log(`cut the quotes from ${await cutImportedQuotes()} imported email message(s)`);
await prisma.$disconnect();
