-- Per-workspace post numbers (#1, #2, …) for /p/<title>-<number> URLs.

ALTER TABLE "workspace" ADD COLUMN "postCount" INTEGER NOT NULL DEFAULT 0;

-- Add as nullable, number existing posts in creation order, then require it.
ALTER TABLE "post" ADD COLUMN "number" INTEGER;

UPDATE "post" p
SET "number" = numbered.n
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", id) AS n
  FROM "post"
) AS numbered
WHERE p.id = numbered.id;

UPDATE "workspace" w
SET "postCount" = COALESCE((SELECT MAX("number") FROM "post" p WHERE p."workspaceId" = w.id), 0);

ALTER TABLE "post" ALTER COLUMN "number" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "post_workspaceId_number_key" ON "post"("workspaceId", "number");
