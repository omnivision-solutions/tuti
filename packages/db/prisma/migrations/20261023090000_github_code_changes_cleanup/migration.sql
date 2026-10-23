-- Linking by hand, link suggestions, completing posts on merge or release, and the pull request
-- comment are gone: code changes (docs/plan.md) propose what a merged pull request changes.
ALTER TABLE "github_installation" DROP COLUMN "closeOn", DROP COLUMN "commentOnPullRequests";
DROP TYPE "GithubCloseOn";
DROP TABLE "github_pr_comment";
DROP TABLE "link_suggestion";
DROP TYPE "LinkSuggestionStatus";
