-- CreateEnum
CREATE TYPE "SchoolStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubscriptionMode" AS ENUM ('UNLIMITED', 'ENFORCED');

-- CreateEnum
CREATE TYPE "DomainKind" AS ENUM ('SUBDOMAIN', 'CUSTOM');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "MembershipKind" AS ENUM ('STAFF', 'PARENT', 'STUDENT');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('SCHOOL', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AuthTokenPurpose" AS ENUM ('ACTIVATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

-- CreateEnum
CREATE TYPE "AcademicYearStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "EducationStage" AS ENUM ('CRECHE', 'NURSERY', 'KINDERGARTEN', 'PRIMARY', 'JHS');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('FEMALE', 'MALE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'TRANSFERRED', 'WITHDRAWN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GuardianRelationship" AS ENUM ('MOTHER', 'FATHER', 'GUARDIAN', 'GRANDPARENT', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('BIRTH_CERTIFICATE', 'PHOTO', 'PREVIOUS_REPORT', 'MEDICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "AdjustmentKind" AS ENUM ('DISCOUNT', 'WAIVER', 'CHARGE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CARD', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECORDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ResultSheetStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('EVERYONE', 'STAFF', 'PARENTS', 'STUDENTS');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'TERMLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SubscriptionState" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "PostKind" AS ENUM ('NEWS', 'EVENT');

-- CreateEnum
CREATE TYPE "CopyStatus" AS ENUM ('AVAILABLE', 'ON_LOAN', 'LOST', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TransportDirection" AS ENUM ('BOTH', 'MORNING', 'AFTERNOON');

-- CreateEnum
CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'GRADUATED', 'INACTIVE');

-- CreateTable
CREATE TABLE "schools" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "SchoolStatus" NOT NULL DEFAULT 'ACTIVE',
    "subscriptionMode" "SubscriptionMode" NOT NULL DEFAULT 'UNLIMITED',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Accra',
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "motto" TEXT,
    "addressLine" TEXT,
    "city" TEXT,
    "region" TEXT,
    "phone" TEXT,
    "contactEmail" TEXT,
    "setupCompletedAt" TIMESTAMPTZ(3),
    "admissionNumberPrefix" TEXT,
    "attendanceCorrectionDays" INTEGER NOT NULL DEFAULT 14,
    "notifyAbsence" BOOLEAN NOT NULL DEFAULT true,
    "studentPortalFees" BOOLEAN NOT NULL DEFAULT false,
    "siteEnabled" BOOLEAN NOT NULL DEFAULT false,
    "siteTagline" TEXT,
    "libraryMaxLoans" INTEGER NOT NULL DEFAULT 3,
    "libraryLoanDays" INTEGER NOT NULL DEFAULT 14,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_domains" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "kind" "DomainKind" NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "school_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "platformRole" "PlatformRole",
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaPendingSecret" TEXT,
    "mfaLastStep" INTEGER,
    "mfaRecoveryCodes" TEXT[],
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_memberships" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "MembershipKind" NOT NULL DEFAULT 'STAFF',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "school_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "membershipId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "staffNumber" TEXT,
    "jobTitle" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("membershipId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "schoolId" UUID,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "rotatedFromId" UUID,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "AuthTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "schoolId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL DEFAULT 'SCHOOL',

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "membership_roles" (
    "schoolId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("membershipId","roleId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "schoolId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "summary" JSONB,
    "correlationId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "admissionNumber" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "otherNames" TEXT,
    "dateOfBirth" DATE,
    "sex" "Sex",
    "admissionDate" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousSchool" TEXT,
    "homeAddress" TEXT,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMPTZ(3),
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_years" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "AcademicYearStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "education_levels" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stage" "EducationStage" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "education_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "levelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_teachers" (
    "classId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_teachers_pkey" PRIMARY KEY ("classId")
);

-- CreateTable
CREATE TABLE "class_subjects" (
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,

    CONSTRAINT "class_subjects_pkey" PRIMARY KEY ("classId","subjectId")
);

-- CreateTable
CREATE TABLE "subject_teachers" (
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_teachers_pkey" PRIMARY KEY ("classId","subjectId")
);

-- CreateTable
CREATE TABLE "school_counters" (
    "schoolId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "school_counters_pkey" PRIMARY KEY ("schoolId","key")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "endReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardians" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "occupation" TEXT,
    "address" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_guardians" (
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "guardianId" UUID NOT NULL,
    "relationship" "GuardianRelationship" NOT NULL,
    "isPrimaryContact" BOOLEAN NOT NULL DEFAULT false,
    "portalAccess" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_guardians_pkey" PRIMARY KEY ("studentId","guardianId")
);

-- CreateTable
CREATE TABLE "student_documents" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "note" TEXT,
    "uploadedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_sessions" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "slot" TEXT NOT NULL DEFAULT 'DAY',
    "recordedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "recordedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("sessionId","studentId")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "fromStatus" "AttendanceStatus" NOT NULL,
    "toStatus" "AttendanceStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "schoolId" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_categories" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structures" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "levelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dueDate" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fee_structures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_structure_items" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "structureId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "description" TEXT,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "fee_structure_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "currency" CHAR(3) NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "dueDate" DATE,
    "sourceStructureId" UUID,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_adjustments" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "kind" "AdjustmentKind" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receivedOn" DATE NOT NULL,
    "payerName" TEXT,
    "note" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "recordedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMPTZ(3),
    "reversalReason" TEXT,
    "reversedByUserId" UUID,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "schoolId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("paymentId","invoiceId")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(3),

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_bands" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "minPercent" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "remark" TEXT NOT NULL,

    CONSTRAINT "grading_bands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "maxMarks" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "result_sheets" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "status" "ResultSheetStatus" NOT NULL DEFAULT 'DRAFT',
    "returnReason" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "submittedByUserId" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedByUserId" UUID,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedByUserId" UUID,
    "snapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "result_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marks" (
    "schoolId" UUID NOT NULL,
    "sheetId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "score" DECIMAL(6,1),
    "absent" BOOLEAN NOT NULL DEFAULT false,
    "enteredByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "marks_pkey" PRIMARY KEY ("sheetId","assessmentId","studentId")
);

-- CreateTable
CREATE TABLE "subject_results" (
    "schoolId" UUID NOT NULL,
    "sheetId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "totalPercent" DECIMAL(5,1) NOT NULL,
    "grade" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "subject_results_pkey" PRIMARY KEY ("sheetId","studentId")
);

-- CreateTable
CREATE TABLE "result_corrections" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "sheetId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "fromScore" DECIMAL(6,1),
    "fromAbsent" BOOLEAN NOT NULL,
    "toScore" DECIMAL(6,1),
    "toAbsent" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "result_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_periods" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isBreak" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "timetable_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_entries" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "classId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,

    CONSTRAINT "timetable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "AnnouncementAudience" NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_classes" (
    "schoolId" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "classId" UUID NOT NULL,

    CONSTRAINT "announcement_classes_pkey" PRIMARY KEY ("announcementId","classId")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "schoolId" UUID,
    "kind" TEXT,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "fileName" TEXT,
    "error" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "host" TEXT,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "billingPeriod" "BillingPeriod" NOT NULL,
    "maxStudents" INTEGER,
    "maxStaff" INTEGER,
    "features" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "state" "SubscriptionState" NOT NULL,
    "trialEndsAt" TIMESTAMPTZ(3),
    "currentPeriodStart" TIMESTAMPTZ(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMPTZ(3) NOT NULL,
    "graceDays" INTEGER NOT NULL DEFAULT 14,
    "graceUntil" TIMESTAMPTZ(3),
    "cancelAt" TIMESTAMPTZ(3),
    "suspendedReason" TEXT,
    "lastNotifiedStatus" TEXT,
    "reminderSentFor" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "details" JSONB,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_pages" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "showInNav" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "seoDescription" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_posts" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "kind" "PostKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" TEXT NOT NULL,
    "coverMediaId" UUID,
    "eventStartsAt" TIMESTAMPTZ(3),
    "eventLocation" TEXT,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "site_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_media" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "altText" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "handledAt" TIMESTAMPTZ(3),
    "handledByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_books" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "isbn" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "library_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_copies" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "bookId" UUID NOT NULL,
    "accessionNumber" TEXT NOT NULL,
    "status" "CopyStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "library_loans" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "copyId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueOn" DATE NOT NULL,
    "returnedAt" TIMESTAMPTZ(3),
    "issuedByUserId" UUID NOT NULL,
    "returnedByUserId" UUID,

    CONSTRAINT "library_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_routes" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "vehicle" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transport_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_stops" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "pickupTime" TEXT,
    "dropoffTime" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "transport_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_assignments" (
    "schoolId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "stopId" UUID NOT NULL,
    "direction" "TransportDirection" NOT NULL DEFAULT 'BOTH',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_assignments_pkey" PRIMARY KEY ("schoolId","studentId")
);

-- CreateTable
CREATE TABLE "leave_types" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "daysPerYear" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "leave_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "schools_slug_key" ON "schools"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "school_domains_hostname_key" ON "school_domains"("hostname");

-- CreateIndex
CREATE INDEX "school_domains_schoolId_idx" ON "school_domains"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "school_memberships_userId_idx" ON "school_memberships"("userId");

-- CreateIndex
CREATE INDEX "school_memberships_schoolId_kind_status_idx" ON "school_memberships"("schoolId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "school_memberships_schoolId_userId_key" ON "school_memberships"("schoolId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "school_memberships_schoolId_id_key" ON "school_memberships"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_schoolId_membershipId_key" ON "staff_profiles"("schoolId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_schoolId_staffNumber_key" ON "staff_profiles"("schoolId", "staffNumber");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_expiresAt_idx" ON "sessions"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_purpose_idx" ON "auth_tokens"("userId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "roles_schoolId_key_key" ON "roles"("schoolId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "roles_schoolId_id_key" ON "roles"("schoolId", "id");

-- CreateIndex
CREATE INDEX "role_permissions_schoolId_idx" ON "role_permissions"("schoolId");

-- CreateIndex
CREATE INDEX "membership_roles_schoolId_idx" ON "membership_roles"("schoolId");

-- CreateIndex
CREATE INDEX "audit_logs_schoolId_createdAt_idx" ON "audit_logs"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "students_schoolId_status_idx" ON "students"("schoolId", "status");

-- CreateIndex
CREATE INDEX "students_schoolId_lastName_firstName_idx" ON "students"("schoolId", "lastName", "firstName");

-- CreateIndex
CREATE UNIQUE INDEX "students_schoolId_admissionNumber_key" ON "students"("schoolId", "admissionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "students_schoolId_id_key" ON "students"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "students_schoolId_userId_key" ON "students"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "academic_years_schoolId_status_idx" ON "academic_years"("schoolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_schoolId_name_key" ON "academic_years"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "academic_years_schoolId_id_key" ON "academic_years"("schoolId", "id");

-- CreateIndex
CREATE INDEX "terms_schoolId_idx" ON "terms"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "terms_academicYearId_name_key" ON "terms"("academicYearId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "terms_schoolId_id_key" ON "terms"("schoolId", "id");

-- CreateIndex
CREATE INDEX "education_levels_schoolId_sortOrder_idx" ON "education_levels"("schoolId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "education_levels_schoolId_name_key" ON "education_levels"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "education_levels_schoolId_id_key" ON "education_levels"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_schoolId_code_key" ON "subjects"("schoolId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_schoolId_name_key" ON "subjects"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_schoolId_id_key" ON "subjects"("schoolId", "id");

-- CreateIndex
CREATE INDEX "classes_schoolId_academicYearId_idx" ON "classes"("schoolId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "classes_academicYearId_name_key" ON "classes"("academicYearId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "classes_schoolId_id_key" ON "classes"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "classes_schoolId_id_academicYearId_key" ON "classes"("schoolId", "id", "academicYearId");

-- CreateIndex
CREATE INDEX "class_teachers_schoolId_membershipId_idx" ON "class_teachers"("schoolId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "class_teachers_schoolId_classId_key" ON "class_teachers"("schoolId", "classId");

-- CreateIndex
CREATE INDEX "class_subjects_schoolId_subjectId_idx" ON "class_subjects"("schoolId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "class_subjects_schoolId_classId_subjectId_key" ON "class_subjects"("schoolId", "classId", "subjectId");

-- CreateIndex
CREATE INDEX "subject_teachers_schoolId_membershipId_idx" ON "subject_teachers"("schoolId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "subject_teachers_schoolId_classId_subjectId_key" ON "subject_teachers"("schoolId", "classId", "subjectId");

-- CreateIndex
CREATE INDEX "enrollments_schoolId_classId_status_idx" ON "enrollments"("schoolId", "classId", "status");

-- CreateIndex
CREATE INDEX "enrollments_studentId_academicYearId_idx" ON "enrollments"("studentId", "academicYearId");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_schoolId_id_key" ON "enrollments"("schoolId", "id");

-- CreateIndex
CREATE INDEX "guardians_schoolId_fullName_idx" ON "guardians"("schoolId", "fullName");

-- CreateIndex
CREATE UNIQUE INDEX "guardians_schoolId_id_key" ON "guardians"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "guardians_schoolId_userId_key" ON "guardians"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "student_guardians_schoolId_guardianId_idx" ON "student_guardians"("schoolId", "guardianId");

-- CreateIndex
CREATE UNIQUE INDEX "student_documents_storageKey_key" ON "student_documents"("storageKey");

-- CreateIndex
CREATE INDEX "student_documents_schoolId_studentId_idx" ON "student_documents"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "student_documents_schoolId_id_key" ON "student_documents"("schoolId", "id");

-- CreateIndex
CREATE INDEX "attendance_sessions_schoolId_date_idx" ON "attendance_sessions"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_classId_date_slot_key" ON "attendance_sessions"("classId", "date", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_sessions_schoolId_id_key" ON "attendance_sessions"("schoolId", "id");

-- CreateIndex
CREATE INDEX "attendance_records_schoolId_studentId_idx" ON "attendance_records"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "attendance_records_schoolId_status_idx" ON "attendance_records"("schoolId", "status");

-- CreateIndex
CREATE INDEX "attendance_corrections_schoolId_sessionId_idx" ON "attendance_corrections"("schoolId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupeKey_key" ON "outbox_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "outbox_events_processedAt_failedAt_availableAt_idx" ON "outbox_events"("processedAt", "failedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "fee_categories_schoolId_name_key" ON "fee_categories"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "fee_categories_schoolId_id_key" ON "fee_categories"("schoolId", "id");

-- CreateIndex
CREATE INDEX "fee_structures_schoolId_termId_idx" ON "fee_structures"("schoolId", "termId");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structures_termId_levelId_name_key" ON "fee_structures"("termId", "levelId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structures_schoolId_id_key" ON "fee_structures"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_structure_items_structureId_categoryId_key" ON "fee_structure_items"("structureId", "categoryId");

-- CreateIndex
CREATE INDEX "invoices_schoolId_studentId_idx" ON "invoices"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "invoices_schoolId_termId_status_idx" ON "invoices"("schoolId", "termId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_schoolId_number_key" ON "invoices"("schoolId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_schoolId_id_key" ON "invoices"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_schoolId_id_studentId_key" ON "invoices"("schoolId", "id", "studentId");

-- CreateIndex
CREATE INDEX "invoice_items_schoolId_invoiceId_idx" ON "invoice_items"("schoolId", "invoiceId");

-- CreateIndex
CREATE INDEX "invoice_adjustments_schoolId_invoiceId_idx" ON "invoice_adjustments"("schoolId", "invoiceId");

-- CreateIndex
CREATE INDEX "payments_schoolId_studentId_idx" ON "payments"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "payments_schoolId_receivedOn_idx" ON "payments"("schoolId", "receivedOn");

-- CreateIndex
CREATE UNIQUE INDEX "payments_schoolId_idempotencyKey_key" ON "payments"("schoolId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payments_schoolId_id_key" ON "payments"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_schoolId_id_studentId_key" ON "payments"("schoolId", "id", "studentId");

-- CreateIndex
CREATE INDEX "payment_allocations_schoolId_invoiceId_idx" ON "payment_allocations"("schoolId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_paymentId_key" ON "receipts"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_schoolId_paymentId_key" ON "receipts"("schoolId", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_schoolId_number_key" ON "receipts"("schoolId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "grading_bands_schoolId_minPercent_key" ON "grading_bands"("schoolId", "minPercent");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_termId_name_key" ON "assessments"("termId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "assessments_schoolId_id_key" ON "assessments"("schoolId", "id");

-- CreateIndex
CREATE INDEX "result_sheets_schoolId_termId_classId_idx" ON "result_sheets"("schoolId", "termId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_termId_classId_subjectId_key" ON "result_sheets"("termId", "classId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "result_sheets_schoolId_id_key" ON "result_sheets"("schoolId", "id");

-- CreateIndex
CREATE INDEX "marks_schoolId_studentId_idx" ON "marks"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "subject_results_schoolId_studentId_idx" ON "subject_results"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "subject_results_schoolId_sheetId_idx" ON "subject_results"("schoolId", "sheetId");

-- CreateIndex
CREATE INDEX "result_corrections_schoolId_sheetId_idx" ON "result_corrections"("schoolId", "sheetId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_periods_schoolId_name_key" ON "timetable_periods"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_periods_schoolId_id_key" ON "timetable_periods"("schoolId", "id");

-- CreateIndex
CREATE INDEX "timetable_entries_schoolId_dayOfWeek_periodId_idx" ON "timetable_entries"("schoolId", "dayOfWeek", "periodId");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_entries_classId_dayOfWeek_periodId_key" ON "timetable_entries"("classId", "dayOfWeek", "periodId");

-- CreateIndex
CREATE INDEX "announcements_schoolId_publishedAt_idx" ON "announcements"("schoolId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "announcements_schoolId_id_key" ON "announcements"("schoolId", "id");

-- CreateIndex
CREATE INDEX "notifications_userId_schoolId_readAt_createdAt_idx" ON "notifications"("userId", "schoolId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "email_deliveries_schoolId_createdAt_idx" ON "email_deliveries"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "email_deliveries_status_createdAt_idx" ON "email_deliveries"("status", "createdAt");

-- CreateIndex
CREATE INDEX "export_jobs_schoolId_createdByUserId_createdAt_idx" ON "export_jobs"("schoolId", "createdByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_schoolId_key" ON "subscriptions"("schoolId");

-- CreateIndex
CREATE INDEX "subscription_events_schoolId_createdAt_idx" ON "subscription_events"("schoolId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_pages_schoolId_slug_key" ON "site_pages"("schoolId", "slug");

-- CreateIndex
CREATE INDEX "site_posts_schoolId_kind_status_publishedAt_idx" ON "site_posts"("schoolId", "kind", "status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_posts_schoolId_slug_key" ON "site_posts"("schoolId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "site_media_storageKey_key" ON "site_media"("storageKey");

-- CreateIndex
CREATE INDEX "site_media_schoolId_createdAt_idx" ON "site_media"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "contact_messages_schoolId_handledAt_createdAt_idx" ON "contact_messages"("schoolId", "handledAt", "createdAt");

-- CreateIndex
CREATE INDEX "library_books_schoolId_title_idx" ON "library_books"("schoolId", "title");

-- CreateIndex
CREATE UNIQUE INDEX "library_books_schoolId_id_key" ON "library_books"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "library_copies_schoolId_accessionNumber_key" ON "library_copies"("schoolId", "accessionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "library_copies_schoolId_id_key" ON "library_copies"("schoolId", "id");

-- CreateIndex
CREATE INDEX "library_loans_schoolId_studentId_idx" ON "library_loans"("schoolId", "studentId");

-- CreateIndex
CREATE INDEX "library_loans_schoolId_returnedAt_dueOn_idx" ON "library_loans"("schoolId", "returnedAt", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "transport_routes_schoolId_name_key" ON "transport_routes"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "transport_routes_schoolId_id_key" ON "transport_routes"("schoolId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "transport_stops_routeId_name_key" ON "transport_stops"("routeId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "transport_stops_schoolId_routeId_id_key" ON "transport_stops"("schoolId", "routeId", "id");

-- CreateIndex
CREATE INDEX "transport_assignments_schoolId_routeId_idx" ON "transport_assignments"("schoolId", "routeId");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_schoolId_name_key" ON "leave_types"("schoolId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "leave_types_schoolId_id_key" ON "leave_types"("schoolId", "id");

-- CreateIndex
CREATE INDEX "leave_requests_schoolId_status_idx" ON "leave_requests"("schoolId", "status");

-- CreateIndex
CREATE INDEX "leave_requests_schoolId_membershipId_idx" ON "leave_requests"("schoolId", "membershipId");

-- AddForeignKey
ALTER TABLE "school_domains" ADD CONSTRAINT "school_domains_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_memberships" ADD CONSTRAINT "school_memberships_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_memberships" ADD CONSTRAINT "school_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_schoolId_membershipId_fkey" FOREIGN KEY ("schoolId", "membershipId") REFERENCES "school_memberships"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_schoolId_roleId_fkey" FOREIGN KEY ("schoolId", "roleId") REFERENCES "roles"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_schoolId_membershipId_fkey" FOREIGN KEY ("schoolId", "membershipId") REFERENCES "school_memberships"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_schoolId_roleId_fkey" FOREIGN KEY ("schoolId", "roleId") REFERENCES "roles"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_years" ADD CONSTRAINT "academic_years_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terms" ADD CONSTRAINT "terms_schoolId_academicYearId_fkey" FOREIGN KEY ("schoolId", "academicYearId") REFERENCES "academic_years"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "education_levels" ADD CONSTRAINT "education_levels_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_schoolId_academicYearId_fkey" FOREIGN KEY ("schoolId", "academicYearId") REFERENCES "academic_years"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_schoolId_levelId_fkey" FOREIGN KEY ("schoolId", "levelId") REFERENCES "education_levels"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_schoolId_classId_fkey" FOREIGN KEY ("schoolId", "classId") REFERENCES "classes"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_teachers" ADD CONSTRAINT "class_teachers_schoolId_membershipId_fkey" FOREIGN KEY ("schoolId", "membershipId") REFERENCES "school_memberships"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_schoolId_classId_fkey" FOREIGN KEY ("schoolId", "classId") REFERENCES "classes"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_subjects" ADD CONSTRAINT "class_subjects_schoolId_subjectId_fkey" FOREIGN KEY ("schoolId", "subjectId") REFERENCES "subjects"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_schoolId_classId_subjectId_fkey" FOREIGN KEY ("schoolId", "classId", "subjectId") REFERENCES "class_subjects"("schoolId", "classId", "subjectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_teachers" ADD CONSTRAINT "subject_teachers_schoolId_membershipId_fkey" FOREIGN KEY ("schoolId", "membershipId") REFERENCES "school_memberships"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_counters" ADD CONSTRAINT "school_counters_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_schoolId_classId_academicYearId_fkey" FOREIGN KEY ("schoolId", "classId", "academicYearId") REFERENCES "classes"("schoolId", "id", "academicYearId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardians" ADD CONSTRAINT "guardians_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_guardians" ADD CONSTRAINT "student_guardians_schoolId_guardianId_fkey" FOREIGN KEY ("schoolId", "guardianId") REFERENCES "guardians"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_documents" ADD CONSTRAINT "student_documents_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_schoolId_classId_academicYearId_fkey" FOREIGN KEY ("schoolId", "classId", "academicYearId") REFERENCES "classes"("schoolId", "id", "academicYearId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_schoolId_termId_fkey" FOREIGN KEY ("schoolId", "termId") REFERENCES "terms"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_schoolId_sessionId_fkey" FOREIGN KEY ("schoolId", "sessionId") REFERENCES "attendance_sessions"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_schoolId_sessionId_fkey" FOREIGN KEY ("schoolId", "sessionId") REFERENCES "attendance_sessions"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_categories" ADD CONSTRAINT "fee_categories_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_schoolId_termId_fkey" FOREIGN KEY ("schoolId", "termId") REFERENCES "terms"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structures" ADD CONSTRAINT "fee_structures_schoolId_levelId_fkey" FOREIGN KEY ("schoolId", "levelId") REFERENCES "education_levels"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_schoolId_structureId_fkey" FOREIGN KEY ("schoolId", "structureId") REFERENCES "fee_structures"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_structure_items" ADD CONSTRAINT "fee_structure_items_schoolId_categoryId_fkey" FOREIGN KEY ("schoolId", "categoryId") REFERENCES "fee_categories"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_schoolId_termId_fkey" FOREIGN KEY ("schoolId", "termId") REFERENCES "terms"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_schoolId_invoiceId_fkey" FOREIGN KEY ("schoolId", "invoiceId") REFERENCES "invoices"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_schoolId_categoryId_fkey" FOREIGN KEY ("schoolId", "categoryId") REFERENCES "fee_categories"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_schoolId_invoiceId_fkey" FOREIGN KEY ("schoolId", "invoiceId") REFERENCES "invoices"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_schoolId_paymentId_studentId_fkey" FOREIGN KEY ("schoolId", "paymentId", "studentId") REFERENCES "payments"("schoolId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_schoolId_invoiceId_studentId_fkey" FOREIGN KEY ("schoolId", "invoiceId", "studentId") REFERENCES "invoices"("schoolId", "id", "studentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_schoolId_paymentId_fkey" FOREIGN KEY ("schoolId", "paymentId") REFERENCES "payments"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_bands" ADD CONSTRAINT "grading_bands_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_schoolId_termId_fkey" FOREIGN KEY ("schoolId", "termId") REFERENCES "terms"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_schoolId_termId_fkey" FOREIGN KEY ("schoolId", "termId") REFERENCES "terms"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_sheets" ADD CONSTRAINT "result_sheets_schoolId_classId_subjectId_fkey" FOREIGN KEY ("schoolId", "classId", "subjectId") REFERENCES "class_subjects"("schoolId", "classId", "subjectId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_schoolId_sheetId_fkey" FOREIGN KEY ("schoolId", "sheetId") REFERENCES "result_sheets"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_schoolId_assessmentId_fkey" FOREIGN KEY ("schoolId", "assessmentId") REFERENCES "assessments"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marks" ADD CONSTRAINT "marks_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_schoolId_sheetId_fkey" FOREIGN KEY ("schoolId", "sheetId") REFERENCES "result_sheets"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_results" ADD CONSTRAINT "subject_results_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_corrections" ADD CONSTRAINT "result_corrections_schoolId_sheetId_fkey" FOREIGN KEY ("schoolId", "sheetId") REFERENCES "result_sheets"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_periods" ADD CONSTRAINT "timetable_periods_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_schoolId_classId_subjectId_fkey" FOREIGN KEY ("schoolId", "classId", "subjectId") REFERENCES "class_subjects"("schoolId", "classId", "subjectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_schoolId_periodId_fkey" FOREIGN KEY ("schoolId", "periodId") REFERENCES "timetable_periods"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_classes" ADD CONSTRAINT "announcement_classes_schoolId_announcementId_fkey" FOREIGN KEY ("schoolId", "announcementId") REFERENCES "announcements"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_classes" ADD CONSTRAINT "announcement_classes_schoolId_classId_fkey" FOREIGN KEY ("schoolId", "classId") REFERENCES "classes"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_posts" ADD CONSTRAINT "site_posts_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_media" ADD CONSTRAINT "site_media_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_schoolId_bookId_fkey" FOREIGN KEY ("schoolId", "bookId") REFERENCES "library_books"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_schoolId_copyId_fkey" FOREIGN KEY ("schoolId", "copyId") REFERENCES "library_copies"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_schoolId_routeId_fkey" FOREIGN KEY ("schoolId", "routeId") REFERENCES "transport_routes"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_schoolId_studentId_fkey" FOREIGN KEY ("schoolId", "studentId") REFERENCES "students"("schoolId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_schoolId_routeId_fkey" FOREIGN KEY ("schoolId", "routeId") REFERENCES "transport_routes"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_schoolId_routeId_stopId_fkey" FOREIGN KEY ("schoolId", "routeId", "stopId") REFERENCES "transport_stops"("schoolId", "routeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_schoolId_membershipId_fkey" FOREIGN KEY ("schoolId", "membershipId") REFERENCES "school_memberships"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_schoolId_typeId_fkey" FOREIGN KEY ("schoolId", "typeId") REFERENCES "leave_types"("schoolId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
