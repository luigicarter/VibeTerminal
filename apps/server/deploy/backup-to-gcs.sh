#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${BACKUP_BUCKET:?Set BACKUP_BUCKET to the approved gs://bucket/prefix}"
case "$BACKUP_BUCKET" in gs://*) ;; *) echo 'BACKUP_BUCKET must use gs://' >&2; exit 1;; esac
umask 077
backup_dir="${BACKUP_DIR:-$PWD/backups}"
mkdir -p "$backup_dir"
backup_file="$backup_dir/lina-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f deploy/compose.yaml exec -T db pg_dump -U postgres -d lina_accounts --format=custom > "$backup_file"
sha256sum "$backup_file" > "$backup_file.sha256"
gcloud storage cp "$backup_file" "$BACKUP_BUCKET/"
gcloud storage cp "$backup_file.sha256" "$BACKUP_BUCKET/"
docker compose -f deploy/compose.yaml exec -T db psql -U postgres -d lina_accounts -v ON_ERROR_STOP=1 -c "INSERT INTO job_status(name,last_success_at) VALUES('backup',now()) ON CONFLICT(name) DO UPDATE SET last_success_at=now()"
echo 'Off-VM backup and checksum uploaded successfully.'
