-- When this server started keeping docs searches a year (they were kept 30 days before): Reporting says since when they're counted.
-- The update fills it in as it runs; a new server's row gets its creation time.
ALTER TABLE "installation" ADD COLUMN "searchesKeptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
