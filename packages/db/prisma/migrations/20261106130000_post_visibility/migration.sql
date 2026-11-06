-- Private posts: who sees a post besides the team (everyone, its author, nobody), and each board's choice for new posts.
CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'TEAM');
ALTER TABLE "board" ADD COLUMN "postVisibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "post" ADD COLUMN "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC';
