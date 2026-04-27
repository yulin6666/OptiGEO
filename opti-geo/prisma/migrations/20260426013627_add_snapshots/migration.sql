-- CreateTable
CREATE TABLE "AuditSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "checksJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DetectionSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "url" TEXT,
    "prompt" TEXT NOT NULL,
    "avgScore" INTEGER NOT NULL,
    "resultsJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AuditSnapshot_shop_idx" ON "AuditSnapshot"("shop");

-- CreateIndex
CREATE INDEX "DetectionSnapshot_shop_idx" ON "DetectionSnapshot"("shop");
