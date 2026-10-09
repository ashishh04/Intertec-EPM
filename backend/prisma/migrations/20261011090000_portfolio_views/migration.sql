-- Saved portfolio views (BR-203).
CREATE TABLE "portfolio_views" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "roleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_views_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "portfolio_views_visibility_check" CHECK ("visibility" IN ('private', 'roles', 'public'))
);

CREATE INDEX "portfolio_views_ownerId_idx" ON "portfolio_views"("ownerId");
CREATE INDEX "portfolio_views_visibility_idx" ON "portfolio_views"("visibility");
