-- "references" is the app's page of an API reference (/app/<project>/docs/references/…), so no
-- article can have it, like "tabs" and "collections" (20261021190000_docs_app_page_slugs). A live
-- article that has it is renamed the way the app picks a slug (references-2, references-3, …): the
-- next one no tab, collection, API reference, live article or reserved name has. A published one's
-- old slug redirects to it, as its portal URL changes; a redirect that had the new slug goes, as when
-- the app takes a slug. Deleted articles don't hold on to their slugs.
DO $$
DECLARE
  page record;
  candidate text;
  n int;
BEGIN
  FOR page IN
    SELECT a.id, a."projectId", a.slug, a."publishedAt"
    FROM "article" a
    WHERE a.slug = 'references' AND a."deletedAt" IS NULL
    ORDER BY a."createdAt", a.id
  LOOP
    n := 2;
    LOOP
      candidate := page.slug || '-' || n;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "article" WHERE "projectId" = page."projectId" AND slug = candidate AND "deletedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "docs_tab" WHERE "projectId" = page."projectId" AND slug = candidate)
        AND NOT EXISTS (SELECT 1 FROM "collection" WHERE "projectId" = page."projectId" AND slug = candidate)
        AND NOT EXISTS (SELECT 1 FROM "api_reference" WHERE "projectId" = page."projectId" AND slug = candidate);
      n := n + 1;
    END LOOP;
    DELETE FROM "docs_redirect" WHERE "projectId" = page."projectId" AND slug = candidate;
    UPDATE "article" SET slug = candidate WHERE id = page.id;
    IF page."publishedAt" IS NOT NULL THEN
      INSERT INTO "docs_redirect" (id, "projectId", slug, "articleId")
      VALUES (gen_random_uuid()::text, page."projectId", page.slug, page.id)
      ON CONFLICT ("projectId", slug) DO UPDATE SET "tabId" = NULL, "collectionId" = NULL, "articleId" = EXCLUDED."articleId";
    END IF;
  END LOOP;
END $$;
