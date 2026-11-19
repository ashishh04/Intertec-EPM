-- HR was retired as an EPM role (November 2026). Looking after people and
-- their timesheets is the Delivery Manager's now; the same rule is read at
-- run time for any row this does not reach (auth/roles.ts, RETIRED_ROLES).
UPDATE "user_profiles" SET "appRole" = 'delivery_manager' WHERE "appRole" = 'hr';
