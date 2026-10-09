#!/usr/bin/env bash
# Ambiente per i test differenziali in CI (o su una macchina nuova) SENZA reinstallare osTicket:
#  - copia il codice PHP di questo repo in $OST_DIR e scrive include/ost-config.php
#  - crea DB e utente su MariaDB locale e carica la fixture dev/fixtures/osticket-dev.sql.gz
#    (stessi dati del seed usato per scrivere i test)
#  - scarica e avvia Mailpit (SMTP 1025, API 8025)
# Variabili: OST_DEV (default /tmp/ost-dev), OST_DB_NAME/USER/PASS, OST_SECRET_SALT.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OST_DEV="${OST_DEV:-/tmp/ost-dev}"
OST_DIR="${OST_DIR:-$OST_DEV/www}"
DB_NAME="${OST_DB_NAME:-osticket}"
DB_USER="${OST_DB_USER:-osticket}"
DB_PASS="${OST_DB_PASS:-osticket}"
SALT="${OST_SECRET_SALT:-ci-secret-salt-0123456789abcdefghijklmnopqrstuv}"
SUDO=""
[[ $EUID -ne 0 ]] && SUDO="sudo"

$SUDO mariadb <<SQL
DROP DATABASE IF EXISTS \`$DB_NAME\`;
CREATE DATABASE \`$DB_NAME\` DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
GRANT ALL ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
GRANT ALL ON \`${DB_NAME}_diff%\`.* TO '$DB_USER'@'localhost';
GRANT ALL ON \`${DB_NAME}_diff%\`.* TO '$DB_USER'@'127.0.0.1';
SQL
gunzip -c "$REPO_DIR/frontend-next/dev/fixtures/osticket-dev.sql.gz" | $SUDO mariadb "$DB_NAME"

mkdir -p "$OST_DIR"
rsync -a --delete --exclude .git --exclude docs --exclude frontend-next --exclude include/ost-config.php "$REPO_DIR/" "$OST_DIR/"
sed -e "s/define('OSTINSTALLED',FALSE);/define('OSTINSTALLED',TRUE);/" \
    -e "s/%CONFIG-SIRI/$SALT/" \
    -e "s/%ADMIN-EMAIL/admin@example.com/" \
    -e "s/%CONFIG-DBHOST/localhost/" \
    -e "s/%CONFIG-DBNAME/$DB_NAME/" \
    -e "s/%CONFIG-DBUSER/$DB_USER/" \
    -e "s/%CONFIG-DBPASS/$DB_PASS/" \
    -e "s/%CONFIG-PREFIX/ost_/" \
    "$OST_DIR/include/ost-sampleconfig.php" > "$OST_DIR/include/ost-config.php"
grep -q "OSTINSTALLED',TRUE" "$OST_DIR/include/ost-config.php"

mkdir -p "$OST_DEV/bin"
if [[ ! -x "$OST_DEV/bin/mailpit" ]]; then
  curl -sSL https://github.com/axllent/mailpit/releases/download/v1.21.8/mailpit-linux-amd64.tar.gz | tar xz -C "$OST_DEV/bin" mailpit
fi
if ! curl -s -o /dev/null http://127.0.0.1:8025/; then
  nohup "$OST_DEV/bin/mailpit" --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 \
    --smtp-auth-accept-any --smtp-auth-allow-insecure >"$OST_DEV/mailpit.log" 2>&1 &
fi

echo "OST_DIR=$OST_DIR"
echo "OST_CONFIG_PATH=$OST_DIR/include/ost-config.php"
echo "OST_SENDMAIL=$OST_DEV/bin/mailpit sendmail -S 127.0.0.1:1025"
