/**
 * Releases uploads no content uses any more, in every project, now instead of at the daily
 * `release-media` run; the hourly `cleanup-media` then deletes them.
 * Run: pnpm --filter @tuti/worker release:media
 */
import { prisma } from "@tuti/db";
import { assertEnv } from "@tuti/shared";

import { handlers } from "@tuti/jobs";

assertEnv(["DATABASE_URL"]);

const { released, projects } = await handlers.releaseMedia({}, { info: () => {}, warn: console.warn });
console.log(`released ${released} upload(s) in ${projects} project(s); cleanup-media deletes them on its next run`);
await prisma.$disconnect();
