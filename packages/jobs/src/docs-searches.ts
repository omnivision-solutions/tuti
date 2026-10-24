import { prisma } from "@tuti/db";
import type { JobInput } from "@tuti/shared";

import type { JobLogger, JobResult } from "./index";

/** How many days the docs' insights cover (today included), and so how long searches are kept. */
export const INSIGHTS_DAYS = 30;

/** How many different failed searches' words are kept per project and day; more still count, without their words. */
export const FAILED_SEARCHES_PER_DAY = 100;

/** Removes docs searches' daily counts and failed searches older than the insights show (INSIGHTS_DAYS, in whole UTC days). */
export async function pruneDocsSearches(_input: JobInput<"pruneDocsSearches">, log: JobLogger): Promise<JobResult> {
  const since = new Date(new Date().toISOString().slice(0, 10));
  since.setUTCDate(since.getUTCDate() - (INSIGHTS_DAYS - 1));
  const [days, failed] = await prisma.$transaction([
    prisma.docsSearchDay.deleteMany({ where: { day: { lt: since } } }),
    prisma.docsFailedSearchDay.deleteMany({ where: { day: { lt: since } } }),
  ]);
  log.info(`pruned ${days.count} day(s) of docs searches and ${failed.count} failed search(es) older than ${INSIGHTS_DAYS} days`);
  return { days: days.count, failed: failed.count };
}
