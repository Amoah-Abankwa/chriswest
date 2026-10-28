#!/usr/bin/env bash
# Zero-surprise deploy on the VPS. Layout: /srv/sms/releases/<stamp>, /srv/sms/current -> a release,
# /srv/sms/shared/{backend.env,frontend.env,storage}.
# Usage: ./deploy.sh <git ref>   (run from anywhere; REPO_URL must be set)
set -euo pipefail
ref=${1:?git ref}
root=/srv/sms
: "${REPO_URL:?}"
stamp=$(date -u +%Y%m%d%H%M%S)
dir="$root/releases/$stamp"
prev=$(readlink -f "$root/current" || true)

git clone --depth 1 --branch "$ref" "$REPO_URL" "$dir"
ln -s "$root/shared/backend.env" "$dir/backend/.env"
ln -s "$root/shared/frontend.env" "$dir/frontend/.env.local"
ln -s "$root/shared/storage" "$dir/backend/storage"

cd "$dir"
npm ci
npm run build
npm run prisma:deploy -w backend   # migrations must work with the previous release too
npm run db:seed -w backend

ln -sfn "$dir" "$root/current"
pm2 startOrReload "$root/current/backend/deploy/ecosystem.config.cjs" --update-env

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/api/v1/health/ready > /dev/null; then
    echo "Deployed $ref ($stamp)"
    ls -1dt "$root"/releases/* | tail -n +6 | xargs -r rm -rf   # keep the last 5
    exit 0
  fi
  sleep 3
done

echo "Health check failed; rolling back"
if [ -n "$prev" ]; then
  ln -sfn "$prev" "$root/current"
  pm2 startOrReload "$root/current/backend/deploy/ecosystem.config.cjs" --update-env
fi
exit 1
