-- Teams become an EPM-owned entity.
--
-- They were previously a reading of OpenProject groups decorated with the
-- team_profiles overlay. A group cannot carry a department, a code or its own
-- lifecycle, and this instance defines no groups, so the feature was empty and
-- could not be used without first creating a group upstream.
--
-- team_profiles is dropped rather than migrated: its rows keyed OpenProject
-- group ids, and with no groups there is nothing to carry over.

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" TEXT,
    "leadId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_code_key" ON "teams"("code");

-- CreateIndex
CREATE INDEX "teams_departmentId_idx" ON "teams"("departmentId");

-- CreateIndex
CREATE INDEX "teams_active_idx" ON "teams"("active");

-- Case-insensitive name uniqueness, as for departments. Raw SQL because Prisma
-- cannot express an index on an expression; the model therefore carries no
-- @unique on name, so no redundant plain index is created alongside.
CREATE UNIQUE INDEX "teams_name_lower_key" ON "teams" (LOWER("name"));

-- AddForeignKey
-- RESTRICT rather than SET NULL: silently orphaning a team is worse than
-- refusing the delete. Departments have no delete route, so this only fires
-- against direct database access, which is where the protection is wanted.
ALTER TABLE "teams" ADD CONSTRAINT "teams_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable
DROP TABLE IF EXISTS "team_profiles";
