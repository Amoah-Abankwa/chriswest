#!/usr/bin/env bash
# Encrypted, off-server backup of the database (and local file storage).
# Needs: pg_dump (same major version as the server), age (or gpg), rclone configured with a remote.
# Env: DIRECT_URL (from backend/.env), BACKUP_RECIPIENT (age public key), BACKUP_REMOTE (e.g. b2:sms-backups)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${DIRECT_URL:?}" "${BACKUP_RECIPIENT:?set an age public key}" "${BACKUP_REMOTE:?set an rclone remote like b2:sms-backups}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "[$stamp] dumping database"
pg_dump --format=custom --no-owner --no-privileges "$DIRECT_URL" > "$work/db.dump"
pg_restore --list "$work/db.dump" > /dev/null   # fails if the dump is unreadable

if [ -d storage ]; then
  echo "[$stamp] archiving local files"
  tar -czf "$work/storage.tar.gz" storage
fi

for f in "$work"/*; do
  age -r "$BACKUP_RECIPIENT" -o "$f.age" "$f"
  rm "$f"
done

day=$(date -u +%d)
rclone copy "$work" "$BACKUP_REMOTE/daily/$stamp"
[ "$day" = "01" ] && rclone copy "$work" "$BACKUP_REMOTE/monthly/$stamp"

# Keep 30 daily and 12 monthly backups.
rclone delete "$BACKUP_REMOTE/daily" --min-age 30d --rmdirs
rclone delete "$BACKUP_REMOTE/monthly" --min-age 365d --rmdirs
echo "[$stamp] backup complete"
