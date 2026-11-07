-- 20261106180000_github_lists_narrowed again: while it deployed, the previous release could still save a
-- connection's list as every repository the app could see on the account (Refresh list, connecting), and nothing
-- narrows a list back. No released code saves that list any more, so each keeps only the project's own
-- repositories once more: reconnecting lists the rest, read as the person who connects.
UPDATE "github_installation" gi SET "repositories" = COALESCE(
  (SELECT jsonb_agg(jsonb_build_object('id', gr."repoId", 'fullName', gr."fullName") ORDER BY gr."createdAt")
   FROM "github_repository" gr WHERE gr."connectionId" = gi.id),
  '[]'::jsonb);
