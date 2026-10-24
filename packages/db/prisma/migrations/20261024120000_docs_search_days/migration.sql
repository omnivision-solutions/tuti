-- Docs searches as daily counters instead of a row per search: only the words of searches
-- that found nothing are kept (for the insights' failed searches), and only for the insights'
-- 30 days. The last 30 days' searches carry over; older ones and the words of the rest go.

-- CreateTable
CREATE TABLE "docs_search_day" (
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "searches" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,

    CONSTRAINT "docs_search_day_pkey" PRIMARY KEY ("projectId","day")
);

-- CreateTable
CREATE TABLE "docs_failed_search_day" (
    "projectId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "docs_failed_search_day_pkey" PRIMARY KEY ("projectId","day","query")
);

-- AddForeignKey
ALTER TABLE "docs_search_day" ADD CONSTRAINT "docs_search_day_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_failed_search_day" ADD CONSTRAINT "docs_failed_search_day_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The last 30 days (UTC, today included; "createdAt" is UTC).
INSERT INTO "docs_search_day" ("projectId", "day", "searches", "failed")
SELECT "projectId", "createdAt"::date, count(*), count(*) FILTER (WHERE "results" = 0)
FROM "docs_search"
WHERE "createdAt" >= (now() AT TIME ZONE 'UTC')::date - 29
GROUP BY "projectId", "createdAt"::date;

INSERT INTO "docs_failed_search_day" ("projectId", "day", "query", "count")
SELECT "projectId", "createdAt"::date, "query", count(*)
FROM "docs_search"
WHERE "results" = 0 AND "createdAt" >= (now() AT TIME ZONE 'UTC')::date - 29
GROUP BY "projectId", "createdAt"::date, "query";

-- DropForeignKey
ALTER TABLE "docs_search" DROP CONSTRAINT "docs_search_projectId_fkey";

-- DropTable
DROP TABLE "docs_search";
