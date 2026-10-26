#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env.production-backup"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Fichier absent ou illisible : $ENV_FILE (à créer depuis .env.production-backup.example)" >&2
  exit 1
fi
command -v aws >/dev/null || { echo "AWS CLI est requis pour envoyer la sauvegarde vers S3." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker est requis pour exécuter pg_dump." >&2; exit 1; }

set -a
# Ce fichier est créé à partir du modèle et ne doit contenir que des valeurs shell simples.
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
: "${S3_BUCKET:?S3_BUCKET doit être configuré dans .env.production-backup}"
: "${DATA_PRIVATE_IP:?DATA_PRIVATE_IP doit être configuré dans .env.production-backup}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="s3://${S3_BUCKET}/backups/postgresql/atelier-${STAMP}.dump"

docker run --rm \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  postgres:16-alpine \
  pg_dump --host="$DATA_PRIVATE_IP" --port=5432 --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl \
  | aws s3 cp - "$DESTINATION" --sse AES256 --no-progress

echo "Sauvegarde PostgreSQL envoyée vers $DESTINATION"
