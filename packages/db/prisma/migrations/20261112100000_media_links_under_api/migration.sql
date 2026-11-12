-- Lasting links to images moved from <app>/media/… to <app>/api/media/… (the app's own files under /api), but
-- profile pictures keep theirs as saved, so they broke: point them at the new path. Only links to the app's own
-- images (their id is a media row; a picture copied from another user has no imageId of its own), never a
-- picture from elsewhere (a sign-in provider, an import's CDN), whatever its path.
UPDATE "user" u SET "image" = regexp_replace(u."image", '^(https?://[^/]+)/media/', '\1/api/media/')
WHERE u."image" ~ '^https?://[^/]+/media/'
  AND EXISTS (SELECT 1 FROM "media" m WHERE m."id" = substring(u."image" from '^https?://[^/]+/media/([^/?]+)/'));
