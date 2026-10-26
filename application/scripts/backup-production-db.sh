#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env.production"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Fichier absent ou illisible : $ENV_FILE" >&2
  exit 1
fi
command -v aws >/dev/null || { echo "AWS CLI est requis pour envoyer la sauvegarde vers S3." >&2; exit 1; }

set -a
# Ce fichier est créé à partir du modèle et ne doit contenir que des valeurs shell simples.
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
: "${S3_BUCKET:?S3_BUCKET doit être configuré dans .env.production}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="s3://${S3_BUCKET}/backups/postgresql/atelier-${STAMP}.dump"

docker compose --env-file "$ENV_FILE" -f "$APP_DIR/compose.production.yml" exec -T db \
  sh -ec 'pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  | aws s3 cp - "$DESTINATION" --sse AES256 --no-progress

echo "Sauvegarde PostgreSQL envoyée vers $DESTINATION"
