-- CreateEnum
CREATE TYPE "GithubCloseOn" AS ENUM ('RELEASE', 'MERGE');

-- AlterTable
ALTER TABLE "github_installation" ADD COLUMN     "closeOn" "GithubCloseOn" NOT NULL DEFAULT 'RELEASE';
