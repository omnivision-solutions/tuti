-- A GitHub connection's list (the repositories a project can add) was every repository the app could see on the
-- account; it's now those the person who connected can access there. Lists saved before can't say which those are,
-- so each keeps only the project's own repositories: reconnecting lists the rest, read as that person.
UPDATE "github_installation" gi SET "repositories" = COALESCE(
  (SELECT jsonb_agg(jsonb_build_object('id', gr."repoId", 'fullName', gr."fullName") ORDER BY gr."createdAt")
   FROM "github_repository" gr WHERE gr."connectionId" = gi.id),
  '[]'::jsonb);
