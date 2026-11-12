-- Profile pictures saved as full links to the app's own images (<app>/api/media/<id>/<file>?s=…) are saved as their
-- stored file and signature (m/<id>/<file>?s=…), as uploads and imports save them from this release: the link is made
-- when the user is read (@tuti/db), so it follows APP_URL and the route. Same signature, nothing re-signed. Only links
-- to the app's own images (their id is a media row); a picture from elsewhere stays as it is. The previous release
-- reads both forms (pictureUrl), but still saves full links while it runs beside this one: the next release runs this
-- conversion again (it's safe to repeat) and drops the cleanup's match on full links (packages/jobs/src/cleanup.ts).
UPDATE "user" u SET "image" = regexp_replace(u."image", '^https?://[^/]+/api/media/', 'm/')
WHERE u."image" ~ '^https?://[^/]+/api/media/[^/?]+/[^/?]+[?]s=[\w-]+$'
  AND EXISTS (SELECT 1 FROM "media" m WHERE m."id" = substring(u."image" from '^https?://[^/]+/api/media/([^/?]+)/'));
