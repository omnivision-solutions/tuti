-- Whether all of a group's conditions must match a user, or any one. The release before reads every group as all,
-- which, while a deploy overlaps them, lets fewer users into an "any" group, never more.
CREATE TYPE "GroupMatch" AS ENUM ('all', 'any');
ALTER TABLE "reader_group" ADD COLUMN "match" "GroupMatch" NOT NULL DEFAULT 'all';
