-- An internal cost per hour for a person, for the Time & Costs report.
--
-- Nullable rather than defaulted: OpenProject's costs module keeps rates and
-- publishes no API for them, so EPM starts with nobody costed, and the report
-- reports uncosted hours as such instead of pricing them at zero.
ALTER TABLE "user_profiles" ADD COLUMN "hourlyRate" DOUBLE PRECISION;
