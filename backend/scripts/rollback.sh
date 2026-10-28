#!/usr/bin/env bash
# Switches back to the previous release. Database migrations are NOT reverted (see deploy-rollback.md).
set -euo pipefail
root=/srv/sms
current=$(readlink -f "$root/current")
prev=$(ls -1dt "$root"/releases/* | grep -v "^$current$" | head -1)
[ -n "$prev" ] || { echo "No previous release"; exit 1; }
ln -sfn "$prev" "$root/current"
pm2 startOrReload "$root/current/backend/deploy/ecosystem.config.cjs" --update-env
echo "Rolled back to $(basename "$prev")"
