-- 20261112160000_pictures_saved_without_host again: the release before it still saved profile pictures as full links
-- while it ran beside that one, and from this release the media cleanup only recognises the saved form
-- (packages/jobs/src/cleanup.ts). Safe to repeat: a picture already saved without host or path doesn't match.
UPDATE "user" u SET "image" = regexp_replace(u."image", '^https?://[^/]+/api/media/', 'm/')
WHERE u."image" ~ '^https?://[^/]+/api/media/[^/?]+/[^/?]+[?]s=[\w-]+$'
  AND EXISTS (SELECT 1 FROM "media" m WHERE m."id" = substring(u."image" from '^https?://[^/]+/api/media/([^/?]+)/'));
