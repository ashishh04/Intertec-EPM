-- Backlog ranks: a task's place in its project's backlog or a sprint's list,
-- which the delivery system's version-based sprints do not keep. Only adds.

-- CreateTable
CREATE TABLE "backlog_ranks" (
    "workPackageId" TEXT NOT NULL,
    "rank" DOUBLE PRECISION NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backlog_ranks_pkey" PRIMARY KEY ("workPackageId")
);
