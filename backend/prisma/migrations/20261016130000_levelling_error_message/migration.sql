-- A levelling run's error as a message, beside its English (Module 15's renderStored).
ALTER TABLE "levelling_runs" ADD COLUMN "errorMessage" JSONB;
