-- AlterTable
ALTER TABLE "expense_claims" ADD COLUMN     "exchangeRate" DECIMAL(18,8),
ADD COLUMN     "rateDate" DATE,
ADD COLUMN     "reportingAmount" DECIMAL(14,2),
ADD COLUMN     "reportingCurrency" TEXT;

-- AlterTable
ALTER TABLE "project_profiles" ADD COLUMN     "billingModel" TEXT,
ADD COLUMN     "contractValue" DECIMAL(14,2),
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "rateCardId" TEXT;

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'actual',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate_fixings" (
    "currency" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "rateId" TEXT,
    "fixedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_fixings_pkey" PRIMARY KEY ("currency","day")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card_rates" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "resourceRoleId" TEXT,
    "hourlyRate" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "rate_card_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_phases" (
    "projectId" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_phases_pkey" PRIMARY KEY ("projectId","periodStart")
);

-- CreateTable
CREATE TABLE "billing_milestones" (
    "projectId" INTEGER NOT NULL,
    "workPackageId" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_milestones_pkey" PRIMARY KEY ("projectId","workPackageId")
);

-- CreateTable
CREATE TABLE "billable_items" (
    "id" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "personId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,2) NOT NULL,
    "unitPrice" DECIMAL(14,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reportingAmount" DECIMAL(14,2) NOT NULL,
    "exchangeRate" DECIMAL(18,8) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "batchId" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billable_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_batches" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "itemCount" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "replays" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "reconciliation" JSONB,

    CONSTRAINT "finance_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_setting_sets" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "settings" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_setting_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rates_currency_kind_effectiveFrom_idx" ON "exchange_rates"("currency", "kind", "effectiveFrom");

-- CreateIndex
CREATE INDEX "rate_card_rates_cardId_idx" ON "rate_card_rates"("cardId");

-- CreateIndex
CREATE INDEX "billable_items_projectId_day_idx" ON "billable_items"("projectId", "day");

-- CreateIndex
CREATE INDEX "billable_items_batchId_idx" ON "billable_items"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "billable_items_kind_sourceId_key" ON "billable_items"("kind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "finance_setting_sets_version_key" ON "finance_setting_sets"("version");

-- AddForeignKey
ALTER TABLE "rate_card_rates" ADD CONSTRAINT "rate_card_rates_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_items" ADD CONSTRAINT "billable_items_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "finance_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One default rate card per currency, and one rate per role on a card (one for
-- "everyone else"): partial indexes, which the schema language cannot express.
CREATE UNIQUE INDEX "rate_cards_default_per_currency" ON "rate_cards"("currency") WHERE "isDefault";
CREATE UNIQUE INDEX "rate_card_rates_card_role" ON "rate_card_rates"("cardId", "resourceRoleId") WHERE "resourceRoleId" IS NOT NULL;
CREATE UNIQUE INDEX "rate_card_rates_card_everyone" ON "rate_card_rates"("cardId") WHERE "resourceRoleId" IS NULL;
