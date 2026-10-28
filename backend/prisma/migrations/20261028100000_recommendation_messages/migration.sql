-- A recommendation's title, rationale and effect as message templates, so each reader gets them in their language.
ALTER TABLE "recommendations" ADD COLUMN "messages" JSONB NOT NULL DEFAULT '{}';
