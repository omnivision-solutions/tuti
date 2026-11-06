-- The portal (project) a session was started on: it works on that portal only, never on the app or another portal.
ALTER TABLE "session" ADD COLUMN "projectId" TEXT;
