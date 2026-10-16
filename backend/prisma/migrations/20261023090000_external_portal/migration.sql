-- External users and their roles per project (BR-611 to BR-613).
ALTER TABLE "user_profiles" ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "external_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_roles_name_key" ON "external_roles"("name");

CREATE TABLE "external_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "external_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_access_userId_projectId_key" ON "external_access"("userId", "projectId");
CREATE INDEX "external_access_userId_idx" ON "external_access"("userId");
ALTER TABLE "external_access" ADD CONSTRAINT "external_access_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "external_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The three starting roles and their matrix; an administrator can change them.
INSERT INTO "external_roles" ("id", "name", "description", "permissions", "builtIn", "updatedAt") VALUES
  ('external-client-viewer', 'Client Viewer', 'Follows the project: status, milestones, tasks, documents and the status summary.',
   ARRAY['status','milestones','tasks.all','documents.view','reports'], true, CURRENT_TIMESTAMP),
  ('external-client-contributor', 'Client Contributor', 'As a viewer, and comments, uploads documents and answers approvals sent to them.',
   ARRAY['status','milestones','tasks.all','comment','documents.view','documents.upload','approvals','reports'], true, CURRENT_TIMESTAMP),
  ('external-vendor', 'Vendor / Partner', 'Works the tasks assigned to them: comments, updates their status, logs time, shares documents.',
   ARRAY['status','milestones','tasks.assigned','comment','status.own','time.own','documents.view','documents.upload'], true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
