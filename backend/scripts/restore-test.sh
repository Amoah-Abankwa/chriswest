#!/usr/bin/env bash
# Restores the newest backup into a scratch database and checks it. Run monthly; record the result
# in docs/RUNBOOKS/backup-restore.md.
# Env: BACKUP_REMOTE, AGE_KEY_FILE (private key), RESTORE_TEST_URL (an EMPTY scratch database)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${BACKUP_REMOTE:?}" "${AGE_KEY_FILE:?}" "${RESTORE_TEST_URL:?point at an empty scratch database, never production}"
case "$RESTORE_TEST_URL" in *"$(echo "$DIRECT_URL" | sed 's/.*@//')"*) echo "RESTORE_TEST_URL looks like production. Refusing."; exit 1;; esac

start=$(date +%s)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
latest=$(rclone lsf "$BACKUP_REMOTE/daily" --dirs-only | sort | tail -1)
echo "Testing backup $latest"
rclone copy "$BACKUP_REMOTE/daily/$latest" "$work"
age -d -i "$AGE_KEY_FILE" -o "$work/db.dump" "$work/db.dump.age"
pg_restore --clean --if-exists --no-owner --no-privileges -d "$RESTORE_TEST_URL" "$work/db.dump"

psql "$RESTORE_TEST_URL" -v ON_ERROR_STOP=1 <<'SQL'
\echo '--- row counts ---'
SELECT 'schools' t, count(*) FROM schools UNION ALL SELECT 'students', count(*) FROM students
UNION ALL SELECT 'payments', count(*) FROM payments UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records
UNION ALL SELECT 'subject_results', count(*) FROM subject_results;
\echo '--- newest audit entry (should be close to the backup time) ---'
SELECT max("createdAt") FROM audit_logs;
\echo '--- money adds up: no invoice paid beyond its total ---'
SELECT count(*) AS bad_invoices FROM invoices WHERE "paidMinor" > "totalMinor";
\echo '--- every allocation belongs to its payment''s student ---'
SELECT count(*) AS bad_allocations FROM payment_allocations a JOIN payments p ON p.id = a."paymentId" WHERE p."studentId" <> a."studentId";
SQL
echo "Restore test finished in $(( $(date +%s) - start ))s"
