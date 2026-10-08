#!/usr/bin/env bash
# Avvia i servizi di sviluppo: MariaDB, Mailpit (SMTP finto) e osTicket PHP (server built-in).
# osTicket PHP: http://127.0.0.1:8080   Mailpit UI: http://127.0.0.1:8025   SMTP: 127.0.0.1:1025
set -euo pipefail

OST_DEV="${OST_DEV:-/home/user/ost-dev}"
OST_DIR="${OST_DIR:-$OST_DEV/www}"
MAILPIT="$OST_DEV/bin/mailpit"

service mariadb status >/dev/null 2>&1 || service mariadb start

if [[ ! -x "$MAILPIT" ]]; then
  mkdir -p "$OST_DEV/bin"
  curl -sSL https://github.com/axllent/mailpit/releases/download/v1.21.8/mailpit-linux-amd64.tar.gz \
    | tar xz -C "$OST_DEV/bin" mailpit
fi

if ! curl -s -o /dev/null http://127.0.0.1:8025/; then
  nohup "$MAILPIT" --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 \
    --smtp-auth-accept-any --smtp-auth-allow-insecure >"$OST_DEV/mailpit.log" 2>&1 &
fi

if ! curl -s -o /dev/null http://127.0.0.1:8080/; then
  # mail() di PHP consegna a Mailpit tramite la sua modalità sendmail
  nohup php -S 127.0.0.1:8080 -t "$OST_DIR" \
    -d "sendmail_path=$MAILPIT sendmail -S 127.0.0.1:1025" >"$OST_DEV/php-server.log" 2>&1 &
fi

echo "Servizi avviati: osTicket http://127.0.0.1:8080 · Mailpit http://127.0.0.1:8025"
