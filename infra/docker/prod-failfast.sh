#!/bin/sh
# Production fail-fast for shipped images (dashboard, worker, atomic-bridge).
# Local compose does NOT set DAREX_PROD_FAILFAST, so ${VAR:-dev} compose
# defaults still work. The image CMD itself never bakes :-dev secrets.
#
# Enable from deploy/docker-compose.prod.yml (DAREX_PROD_FAILFAST=true).

set -eu

if [ "${DAREX_PROD_FAILFAST:-}" = "true" ]; then
  if [ "${ALLOW_DEMO_AUTH:-false}" != "false" ]; then
    echo "darex-prod-failfast: ALLOW_DEMO_AUTH must be false" >&2
    exit 1
  fi
  if [ -n "${DB_USER:-}" ] && [ "$DB_USER" != "darex_app" ]; then
    echo "darex-prod-failfast: DB_USER must be darex_app (got $DB_USER)" >&2
    exit 1
  fi
  case "${DB_PASSWORD:-}" in
    ""|changeme|darex_dev_secret|darex_app_dev_secret)
      echo "darex-prod-failfast: DB_PASSWORD is missing or a known dev default" >&2
      exit 1
      ;;
  esac
fi

exec "$@"
