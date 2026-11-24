-- A project's user deleted by its app (users.delete), kept anonymised as "Deleted user".
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deletedAt" TIMESTAMP(3);
