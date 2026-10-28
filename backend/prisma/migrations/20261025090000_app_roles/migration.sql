-- EPM roles: manager, hr or employee per person (null reads as employee).
ALTER TABLE "user_profiles" ADD COLUMN "appRole" TEXT;
