/**
 * Writes a project's waiting article edits again with Autopilot's check (docs/plan.md, E6): those written before the
 * check that nobody changed, each pull request's help center part analysed again, one at a time (it takes a few minutes
 * each). Run by hand, once the project is in
 * AUTOPILOT_CHECKS_PROJECTS, with the worker's environment: pnpm --filter @tuti/worker rewrite:waiting-edits <project slug>
 * Safe to run again or to stop halfway: see rewriteWaitingEdits.
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { rewriteWaitingEdits } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

const slug = process.argv[2];
if (!slug) {
  console.error("Say which project, e.g. rewrite:waiting-edits tuti");
  process.exit(1);
}
const { edits, pullRequests, analysed } = await rewriteWaitingEdits(slug);
console.log(`took out ${edits} waiting edit(s) of ${pullRequests} pull request(s); analysed ${analysed} pull request(s) again`);
await prisma.$disconnect();
