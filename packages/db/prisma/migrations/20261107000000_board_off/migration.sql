-- A board turned off (Board.off): the team's alone, not on the portal.
ALTER TABLE "board" ADD COLUMN "off" BOOLEAN NOT NULL DEFAULT false;
