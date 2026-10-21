-- Reader groups become their own things (Settings → Groups): a group per project for every name
-- collections use today (named after it, matched as it is), each collection linked to its groups,
-- then the old column goes. Who reads what stays the same.

-- CreateTable
CREATE TABLE "reader_group" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reader_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_group" (
    "collectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,

    CONSTRAINT "collection_group_pkey" PRIMARY KEY ("collectionId","groupId")
);

-- CreateIndex
CREATE UNIQUE INDEX "reader_group_projectId_claim_key" ON "reader_group"("projectId", "claim");

-- CreateIndex
CREATE INDEX "collection_group_groupId_idx" ON "collection_group"("groupId");

-- AddForeignKey
ALTER TABLE "reader_group" ADD CONSTRAINT "reader_group_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_group" ADD CONSTRAINT "collection_group_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_group" ADD CONSTRAINT "collection_group_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "reader_group"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- A group for every distinct name collections use, per project.
INSERT INTO "reader_group" ("id", "projectId", "name", "claim", "updatedAt")
SELECT gen_random_uuid()::text, c."projectId", g.claim, g.claim, CURRENT_TIMESTAMP
FROM "collection" c CROSS JOIN LATERAL unnest(c."groups") AS g(claim)
GROUP BY c."projectId", g.claim;

-- Each collection with its groups.
INSERT INTO "collection_group" ("collectionId", "groupId")
SELECT DISTINCT c."id", rg."id"
FROM "collection" c CROSS JOIN LATERAL unnest(c."groups") AS g(claim)
JOIN "reader_group" rg ON rg."projectId" = c."projectId" AND rg."claim" = g.claim;

-- AlterTable
ALTER TABLE "collection" DROP COLUMN "groups";
