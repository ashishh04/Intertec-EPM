-- Time that belongs to no project: daily scrums and follow-ups (November 2026).
CREATE TABLE "internal_time_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "activity" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_time_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "internal_time_entries_userId_spentOn_idx" ON "internal_time_entries"("userId", "spentOn");
CREATE INDEX "internal_time_entries_spentOn_idx" ON "internal_time_entries"("spentOn");
