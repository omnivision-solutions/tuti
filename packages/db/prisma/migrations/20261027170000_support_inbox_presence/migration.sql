-- Support inbox (docs/plan.md, Support inbox, item 5): when someone was last in the widget's Messages, for the team's "Online" dot.
-- CreateTable
CREATE TABLE "widget_presence" (
    "projectId" TEXT NOT NULL,
    "who" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_presence_pkey" PRIMARY KEY ("projectId","who")
);

-- AddForeignKey
ALTER TABLE "widget_presence" ADD CONSTRAINT "widget_presence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

