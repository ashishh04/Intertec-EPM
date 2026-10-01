-- CreateTable
CREATE TABLE "placeholder_people" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "departmentId" TEXT,
    "teamId" TEXT,
    "hoursCapacity" DOUBLE PRECISION NOT NULL DEFAULT 40,
    "convertedTo" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "placeholder_people_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "placeholder_people_departmentId_idx" ON "placeholder_people"("departmentId");

-- CreateIndex
CREATE INDEX "placeholder_people_teamId_idx" ON "placeholder_people"("teamId");

-- AddForeignKey
ALTER TABLE "placeholder_people" ADD CONSTRAINT "placeholder_people_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "placeholder_people" ADD CONSTRAINT "placeholder_people_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique regardless of case, matching how Team and Department enforce it.
-- Prisma's schema cannot express an index on an expression, so it lives here.
-- Converted placeholders are excluded: the name is free again once the real
-- person exists.
CREATE UNIQUE INDEX "placeholder_people_name_lower_key"
  ON "placeholder_people" (LOWER("name"))
  WHERE "convertedTo" IS NULL;
