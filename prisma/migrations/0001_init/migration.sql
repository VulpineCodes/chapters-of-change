-- Chapters of Change — initial migration (hand-authored to match schema.prisma)
CREATE TYPE "Role" AS ENUM ('DONOR','ORG_ADMIN','ORG_MEMBER','ADMIN');
CREATE TYPE "Condition" AS ENUM ('NEW','LIKE_NEW','GOOD','FAIR','POOR');
CREATE TYPE "AgeSuitability" AS ENUM ('ALL_AGES','CHILDREN','TEEN','YOUNG_ADULT','ADULT');
CREATE TYPE "DonationStatus" AS ENUM ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','IN_TRANSIT','DELIVERED','COMPLETED','CANCELLED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING','DELIVERED','FAILED');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING','SENT','FAILED');

CREATE TABLE "Organization" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT, "type" TEXT NOT NULL,
  "city" TEXT, "country" TEXT, "verified" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "User" (
  "id" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL, "role" "Role" NOT NULL,
  "organizationId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "Profile" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "displayName" TEXT NOT NULL, "bio" TEXT, "avatarUrl" TEXT, "city" TEXT, "country" TEXT,
  CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
CREATE TABLE "Listing" (
  "id" TEXT NOT NULL, "donorId" TEXT NOT NULL, "title" TEXT NOT NULL, "description" TEXT, "genre" TEXT NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'English', "condition" "Condition" NOT NULL, "ageSuitability" "AgeSuitability" NOT NULL DEFAULT 'ALL_AGES',
  "quantity" INTEGER NOT NULL, "availableQuantity" INTEGER NOT NULL, "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Listing_genre_idx" ON "Listing"("genre");
CREATE INDEX "Listing_language_idx" ON "Listing"("language");
CREATE INDEX "Listing_isAvailable_idx" ON "Listing"("isAvailable");
CREATE TABLE "DonationRequest" (
  "id" TEXT NOT NULL, "listingId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "requestedById" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL, "message" TEXT, "status" "DonationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DonationRequest_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Donation" (
  "id" TEXT NOT NULL, "listingId" TEXT NOT NULL, "donorId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "requestId" TEXT, "status" "DonationStatus" NOT NULL DEFAULT 'DRAFT', "quantity" INTEGER NOT NULL, "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Donation_requestId_key" ON "Donation"("requestId");
CREATE UNIQUE INDEX "Donation_idempotencyKey_key" ON "Donation"("idempotencyKey");
CREATE INDEX "Donation_status_idx" ON "Donation"("status");
CREATE TABLE "OutboxEvent" (
  "id" TEXT NOT NULL, "type" TEXT NOT NULL, "aggregateId" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processedAt" TIMESTAMP(3),
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status","createdAt");
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DonationRequest" ADD CONSTRAINT "DonationRequest_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DonationRequest" ADD CONSTRAINT "DonationRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DonationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
