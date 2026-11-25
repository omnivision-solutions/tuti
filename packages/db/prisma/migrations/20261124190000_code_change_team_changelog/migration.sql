-- What the team decided about a merged pull request and the changelog (docs/plan.md, Phase 8): 'IN' once they added it
-- by hand (Autopilot's gate no longer takes it out), 'OUT' once they took it out of a draft (nothing puts it back);
-- null while it's Autopilot's own to decide.
-- AlterTable
ALTER TABLE "code_change" ADD COLUMN     "teamChangelog" TEXT;
