-- Repositories are only added by hand: no project takes an account's new repositories by itself.
ALTER TABLE "github_installation" DROP COLUMN "includeNewRepositories", DROP COLUMN "seenRepositoryIds";
