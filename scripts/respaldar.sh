#!/usr/bin/env bash
# Copia de seguridad de la base de datos PostgreSQL (formato comprimido de pg_dump).
# Uso:  DATABASE_URL=postgres://... ./scripts/respaldar.sh [carpeta_destino] [dias_a_conservar]
set -euo pipefail
: "${DATABASE_URL:?Falta DATABASE_URL}"
DEST="${1:-./backups}"
KEEP="${2:-30}"
mkdir -p "$DEST"
FILE="$DEST/caja-$(date +%Y-%m-%d_%H%M).dump"
pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"
echo "Copia creada: $FILE ($(du -h "$FILE" | cut -f1))"
# borra las copias más viejas que KEEP días
find "$DEST" -name 'caja-*.dump' -mtime +"$KEEP" -delete
