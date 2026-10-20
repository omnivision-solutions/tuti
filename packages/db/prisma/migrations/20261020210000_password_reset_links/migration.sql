-- Password reset links asked for on the app host have no project.
ALTER TABLE "sign_in_link" ALTER COLUMN "projectId" DROP NOT NULL;
