-- How the team shows its users' properties: a name of its own and a format, by property.
ALTER TABLE "project" ADD COLUMN "propertyFormats" JSONB NOT NULL DEFAULT '{}';
