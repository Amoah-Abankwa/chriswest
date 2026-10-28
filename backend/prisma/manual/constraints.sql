-- Constraints Prisma's schema language can't express.
-- Append each section to the migration that creates the tables it touches:
--   npx prisma migrate dev --create-only --name <name>   (inside backend/)
--   paste the relevant section at the end of the generated migration.sql
--   npx prisma migrate dev
-- Fresh database? Create one migration and paste the whole file.

-- ===== Phase 1: tenancy =====
CREATE UNIQUE INDEX school_domains_one_primary ON school_domains ("schoolId") WHERE "isPrimary";

-- ===== Phase 3: academic structure =====
-- Supabase: btree_gist is available; enable it from the dashboard if this statement is not permitted.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE UNIQUE INDEX academic_years_one_active ON academic_years ("schoolId") WHERE status = 'ACTIVE';
ALTER TABLE academic_years ADD CONSTRAINT academic_years_dates_valid CHECK ("endDate" > "startDate");
ALTER TABLE academic_years ADD CONSTRAINT academic_years_no_overlap
  EXCLUDE USING gist ("schoolId" WITH =, daterange("startDate", "endDate", '[]') WITH &&);

ALTER TABLE terms ADD CONSTRAINT terms_dates_valid CHECK ("endDate" > "startDate");
ALTER TABLE terms ADD CONSTRAINT terms_no_overlap
  EXCLUDE USING gist ("academicYearId" WITH =, daterange("startDate", "endDate", '[]') WITH &&);

ALTER TABLE classes ADD CONSTRAINT classes_capacity_positive CHECK (capacity IS NULL OR capacity > 0);

-- ===== Phase 4: staff =====
-- Case-insensitive uniqueness for custom role names within a school.
CREATE UNIQUE INDEX roles_school_name_ci ON roles ("schoolId", lower(name));

-- ===== Phase 5: students =====
CREATE UNIQUE INDEX enrollments_one_active_per_year ON enrollments ("studentId", "academicYearId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX student_guardians_one_primary ON student_guardians ("studentId") WHERE "isPrimaryContact";
ALTER TABLE enrollments ADD CONSTRAINT enrollments_dates_valid CHECK ("endDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE student_documents ADD CONSTRAINT student_documents_size_positive CHECK ("sizeBytes" > 0);

-- ===== Phase 7: finance =====
ALTER TABLE fee_structure_items ADD CONSTRAINT fee_structure_items_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE invoice_adjustments ADD CONSTRAINT invoice_adjustments_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_valid CHECK ("totalMinor" >= 0 AND "paidMinor" >= 0 AND "paidMinor" <= "totalMinor");
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK ("amountMinor" > 0);
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_amount_positive CHECK ("amountMinor" > 0);
-- One live (non-void) invoice per student per fee structure.
CREATE UNIQUE INDEX invoices_one_live_per_structure ON invoices ("studentId", "sourceStructureId")
  WHERE "sourceStructureId" IS NOT NULL AND status <> 'VOID';
-- A bank or mobile money reference can't be recorded twice while the payment stands.
CREATE UNIQUE INDEX payments_unique_reference ON payments ("schoolId", method, lower(reference))
  WHERE reference IS NOT NULL AND status = 'RECORDED';

-- ===== Phase 8: results =====
ALTER TABLE grading_bands ADD CONSTRAINT grading_bands_percent_range CHECK ("minPercent" BETWEEN 0 AND 100);
ALTER TABLE assessments ADD CONSTRAINT assessments_values_valid CHECK ("maxMarks" BETWEEN 1 AND 1000 AND weight BETWEEN 1 AND 100);
ALTER TABLE marks ADD CONSTRAINT marks_score_or_absent CHECK ((absent AND score IS NULL) OR (NOT absent AND score IS NOT NULL AND score >= 0));
ALTER TABLE subject_results ADD CONSTRAINT subject_results_percent_range CHECK ("totalPercent" BETWEEN 0 AND 100);

-- ===== Phase 9: portals =====
ALTER TABLE timetable_entries ADD CONSTRAINT timetable_entries_weekday CHECK ("dayOfWeek" BETWEEN 1 AND 7);
ALTER TABLE timetable_periods ADD CONSTRAINT timetable_periods_times CHECK ("startTime" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "endTime" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "endTime" > "startTime");
ALTER TABLE announcements ADD CONSTRAINT announcements_expiry_after_publish CHECK ("expiresAt" IS NULL OR "publishedAt" IS NULL OR "expiresAt" >= "publishedAt");

-- ===== Phase 13: library, transport, leave =====
CREATE UNIQUE INDEX library_loans_one_open_per_copy ON library_loans ("copyId") WHERE "returnedAt" IS NULL;
ALTER TABLE transport_routes ADD CONSTRAINT transport_routes_capacity CHECK (capacity IS NULL OR capacity > 0);
ALTER TABLE leave_types ADD CONSTRAINT leave_types_days CHECK ("daysPerYear" BETWEEN 0 AND 365);
ALTER TABLE leave_requests ADD CONSTRAINT leave_requests_dates CHECK ("endDate" >= "startDate" AND days > 0);
