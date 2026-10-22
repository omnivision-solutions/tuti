-- Customize → Redirects: old addresses on a portal sent on to new ones.
CREATE TABLE "portal_redirect" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_redirect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "portal_redirect_projectId_from_key" ON "portal_redirect"("projectId", "from");

ALTER TABLE "portal_redirect" ADD CONSTRAINT "portal_redirect_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
