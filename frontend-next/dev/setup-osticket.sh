#!/usr/bin/env bash
# Crea un'istanza osTicket PHP di sviluppo (stesso codice di questo repo) su MariaDB locale.
# Uso: frontend-next/dev/setup-osticket.sh [--reset]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OST_DIR="${OST_DIR:-/home/user/ost-dev/www}"
export OST_DB_NAME="${OST_DB_NAME:-osticket}"
export OST_DB_USER="${OST_DB_USER:-osticket}"
export OST_DB_PASS="${OST_DB_PASS:-osticket}"
export OST_PREFIX="${OST_PREFIX:-ost_}"

if [[ "${1:-}" == "--reset" ]]; then
  mariadb -e "DROP DATABASE IF EXISTS \`$OST_DB_NAME\`"
  rm -rf "$OST_DIR"
fi

mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$OST_DB_NAME\` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
CREATE USER IF NOT EXISTS '$OST_DB_USER'@'localhost' IDENTIFIED BY '$OST_DB_PASS';
CREATE USER IF NOT EXISTS '$OST_DB_USER'@'127.0.0.1' IDENTIFIED BY '$OST_DB_PASS';
GRANT ALL ON \`$OST_DB_NAME\`.* TO '$OST_DB_USER'@'localhost';
GRANT ALL ON \`$OST_DB_NAME\`.* TO '$OST_DB_USER'@'127.0.0.1';
-- Database "di lavoro" per gli snapshot dell'harness differenziale
GRANT ALL ON \`${OST_DB_NAME}_diff%\`.* TO '$OST_DB_USER'@'localhost';
GRANT ALL ON \`${OST_DB_NAME}_diff%\`.* TO '$OST_DB_USER'@'127.0.0.1';
SQL

mkdir -p "$OST_DIR"
rsync -a --delete \
  --exclude .git --exclude docs --exclude frontend-next \
  --exclude include/ost-config.php \
  "$REPO_DIR/" "$OST_DIR/"

if [[ ! -s "$OST_DIR/include/ost-config.php" ]] || ! grep -q "OSTINSTALLED',TRUE" "$OST_DIR/include/ost-config.php"; then
  cp "$OST_DIR/include/ost-sampleconfig.php" "$OST_DIR/include/ost-config.php"
  chmod 0666 "$OST_DIR/include/ost-config.php"
  php "$REPO_DIR/frontend-next/dev/osticket-install.php" "$OST_DIR"
fi

echo "osTicket PHP pronto in $OST_DIR (DB $OST_DB_NAME, prefisso $OST_PREFIX)."
echo "Avvio: php -S 127.0.0.1:8080 -t $OST_DIR"
