-- A tab, a collection and an article can't share a slug in a project, so /docs/<slug> is one page.
-- Today's clashes are renamed the way the app picks a slug (billing-2, billing-3, …): articles keep
-- theirs (their links are out there), then tabs keep theirs, and collections that clash are renamed
-- last; oldest first within a kind. A new slug is one no tab, collection or article in the project
-- has, so renaming makes no new clash. Deleted articles don't hold on to their slugs.
DO $$
DECLARE
  page record;
  candidate text;
  n int;
BEGIN
  FOR page IN
    SELECT 0 AS kind, t.id, t."projectId", t.slug, t."createdAt"
    FROM "docs_tab" t
    WHERE EXISTS (SELECT 1 FROM "article" a WHERE a."projectId" = t."projectId" AND a.slug = t.slug AND a."deletedAt" IS NULL)
    UNION ALL
    SELECT 1, c.id, c."projectId", c.slug, c."createdAt"
    FROM "collection" c
    WHERE EXISTS (SELECT 1 FROM "article" a WHERE a."projectId" = c."projectId" AND a.slug = c.slug AND a."deletedAt" IS NULL)
       OR EXISTS (SELECT 1 FROM "docs_tab" t WHERE t."projectId" = c."projectId" AND t.slug = c.slug)
    ORDER BY kind, "createdAt", id
  LOOP
    n := 2;
    LOOP
      candidate := page.slug || '-' || n;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "article" WHERE "projectId" = page."projectId" AND slug = candidate AND "deletedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "docs_tab" WHERE "projectId" = page."projectId" AND slug = candidate)
        AND NOT EXISTS (SELECT 1 FROM "collection" WHERE "projectId" = page."projectId" AND slug = candidate);
      n := n + 1;
    END LOOP;
    IF page.kind = 0 THEN
      UPDATE "docs_tab" SET slug = candidate WHERE id = page.id;
    ELSE
      UPDATE "collection" SET slug = candidate WHERE id = page.id;
    END IF;
  END LOOP;
END $$;
