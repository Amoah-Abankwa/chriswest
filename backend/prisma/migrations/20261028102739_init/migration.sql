/*
  Warnings:

  - You are about to drop the column `subscriptionMode` on the `schools` table. All the data in the column will be lost.
  - You are about to drop the `subscription_events` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `subscription_plans` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `subscriptions` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "SessionClient" AS ENUM ('WEB', 'MOBILE');

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_planId_fkey";

-- DropForeignKey
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_schoolId_fkey";

-- AlterTable
ALTER TABLE "schools" DROP COLUMN "subscriptionMode";

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "client" "SessionClient" NOT NULL DEFAULT 'WEB';

-- DropTable
DROP TABLE "subscription_events";

-- DropTable
DROP TABLE "subscription_plans";

-- DropTable
DROP TABLE "subscriptions";

-- DropEnum
DROP TYPE "BillingPeriod";

-- DropEnum
DROP TYPE "SubscriptionMode";

-- DropEnum
DROP TYPE "SubscriptionState";
