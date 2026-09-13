#!/usr/bin/env bash
set -euo pipefail
test_data=/tmp/lina-isolated-postgres
install -d -o postgres -g postgres "$test_data"
gosu postgres initdb -D "$test_data" -U postgres -A trust --encoding=UTF8 --locale=C >/dev/null
gosu postgres pg_ctl -D "$test_data" -l /tmp/lina-postgres.log -o '-h 127.0.0.1 -p 15439' -w start >/dev/null
trap 'gosu postgres pg_ctl -D "$test_data" -m fast -w stop >/dev/null' EXIT
export LINA_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:15439/postgres
export LINA_TEST_ALLOW_PROVISION=1
mkdir -p .tmp
bun --no-env-file test --timeout 30000
