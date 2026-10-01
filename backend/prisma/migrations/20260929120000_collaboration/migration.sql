-- Meetings, news and wiki pages.
--
-- EPM's own records, not overlays. OpenProject has all three as modules and
-- publishes none of them over API v3, so there is nothing upstream to key off.

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "projectId" TEXT,
    "location" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "agenda" TEXT,
    "minutes" TEXT,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meetings_projectId_idx" ON "meetings"("projectId");
CREATE INDEX "meetings_startsAt_idx" ON "meetings"("startsAt");

-- CreateTable
CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invited" BOOLEAN NOT NULL DEFAULT true,
    "attended" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_participants_meetingId_userId_key" ON "meeting_participants"("meetingId", "userId");
CREATE INDEX "meeting_participants_userId_idx" ON "meeting_participants"("userId");

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "news_posts" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "projectId" TEXT,
    "authorId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "news_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "news_posts_projectId_idx" ON "news_posts"("projectId");
CREATE INDEX "news_posts_publishedAt_idx" ON "news_posts"("publishedAt");

-- CreateTable
CREATE TABLE "wiki_pages" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "projectId" TEXT,
    "parentId" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wiki_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_pages_projectId_idx" ON "wiki_pages"("projectId");
CREATE INDEX "wiki_pages_parentId_idx" ON "wiki_pages"("parentId");

-- A slug is unique within its project. Two indexes rather than one, because
-- Postgres treats NULLs as distinct: a plain UNIQUE (projectId, slug) would let
-- the organisation-wide wiki hold any number of pages called "home". Prisma's
-- schema cannot express a partial index, so both live here.
CREATE UNIQUE INDEX "wiki_pages_project_slug_key"
    ON "wiki_pages"("projectId", "slug") WHERE "projectId" IS NOT NULL;
CREATE UNIQUE INDEX "wiki_pages_global_slug_key"
    ON "wiki_pages"("slug") WHERE "projectId" IS NULL;

-- AddForeignKey
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "wiki_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "wiki_revisions" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wiki_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wiki_revisions_pageId_createdAt_idx" ON "wiki_revisions"("pageId", "createdAt");

-- AddForeignKey
ALTER TABLE "wiki_revisions" ADD CONSTRAINT "wiki_revisions_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "wiki_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
