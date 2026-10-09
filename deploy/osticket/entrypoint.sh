#!/bin/sh
# Entrypoint dell'immagine osTicket classico di TailTicket.
#   web  (default): genera ost-config.php, installa osTicket se il DB è vuoto, aggiorna lo schema se serve, avvia Apache
#   cron          : esegue api/cron.php ogni CRON_INTERVAL secondi (fetch email, SLA/overdue, pulizie)
#   altro         : esegue il comando indicato (es. "php manage.php upgrade")
set -eu

ROLE="${1:-web}"
OST=/var/www/html/classic
LIB=/usr/local/lib/tailticket
export TAILTICKET_ROLE="$ROLE"

log() { echo "[tailticket-legacy:$ROLE] $*"; }

: "${OST_SECRET_SALT:?OST_SECRET_SALT obbligatoria (vedi deploy/.env)}"
: "${OST_DB_PASS:?OST_DB_PASS obbligatoria}"

# 1. Configurazione di osTicket dalle variabili d'ambiente (mai salvata nell'immagine)
php "$LIB/gen-config.php" "$OST/include/ost-sampleconfig.php" "$OST/include/ost-config.php" >/dev/null
chown root:www-data "$OST/include/ost-config.php"
chmod 0640 "$OST/include/ost-config.php"

# 2. Email in uscita del PHP: mail() → msmtp verso SMTP_URL (smtp[s]://utente:password@host:porta)
if [ -n "${SMTP_URL:-}" ]; then
  php -r '
    $u = parse_url(getenv("SMTP_URL"));
    $tls = ($u["scheme"] ?? "smtp") === "smtps" ? "on" : "off";
    $starttls = ($u["scheme"] ?? "smtp") === "smtp" && !empty($u["user"]) ? "on" : "off";
    $c = "defaults\nlogfile -\naccount default\nhost ".$u["host"]."\nport ".($u["port"] ?? ($tls === "on" ? 465 : 25))."\n";
    $c .= "tls ".($tls === "on" || $starttls === "on" ? "on" : "off")."\ntls_starttls ".($starttls)."\n";
    $c .= "tls_trust_file /etc/ssl/certs/ca-certificates.crt\n";
    if (!empty($u["user"])) $c .= "auth on\nuser ".urldecode($u["user"])."\npassword ".urldecode($u["pass"] ?? "")."\n";
    $c .= "from ".(getenv("TAILTICKET_SYSTEM_EMAIL") ?: "support@example.com")."\n";
    file_put_contents("/etc/msmtprc", $c);'
  chown root:www-data /etc/msmtprc && chmod 0640 /etc/msmtprc
fi

# 3. Attesa del database
i=0
until state=$(php "$LIB/db-state.php" 2>/dev/null) && [ "$state" != "unreachable" ]; do
  i=$((i + 1)); [ "$i" -gt 90 ] && { log "database non raggiungibile"; exit 1; }
  sleep 2
done

case "$ROLE" in
  web)
    if [ "$state" = "empty" ]; then
      if [ "${TAILTICKET_INSTALL:-auto}" != "auto" ]; then
        log "database vuoto e TAILTICKET_INSTALL=${TAILTICKET_INSTALL}: installazione automatica disattivata"; exit 1
      fi
      log "database vuoto: installazione di osTicket"
      cp -a /usr/local/share/osticket-setup "$OST/setup"
      tmp=$(mktemp /tmp/ost-config.XXXXXX.php)
      php "$LIB/install.php" "$OST" "$tmp"
      rm -rf "$OST/setup" "$tmp"
      log "installazione completata"
    else
      # schema da aggiornare (nuova versione di osTicket nell'immagine)? manage.php upgrade, senza setup/
      if [ "${TAILTICKET_AUTO_UPGRADE:-true}" = "true" ]; then
        (cd "$OST" && php manage.php upgrade 2>&1 | sed 's/^/[upgrade] /') || log "upgrade non riuscito: controllare i log"
      fi
    fi
    # helpdesk_url allineato all'URL pubblico (link nelle email del PHP e di TailTicket)
    if [ "${TAILTICKET_SYNC_URL:-true}" = "true" ] && [ -n "${TAILTICKET_URL:-}" ]; then
      php -r '
        mysqli_report(MYSQLI_REPORT_OFF);
        $g = fn($k, $d) => getenv($k) ?: $d;
        $db = new mysqli($g("OST_DB_HOST","db"), $g("OST_DB_USER","osticket"), getenv("OST_DB_PASS"), $g("OST_DB_NAME","osticket"), (int) $g("OST_DB_PORT","3306"));
        $url = rtrim(getenv("TAILTICKET_URL"), "/")."/classic/";
        $st = $db->prepare("UPDATE `".$g("OST_TABLE_PREFIX","ost_")."config` SET value=?, updated=NOW() WHERE namespace=\"core\" AND `key`=\"helpdesk_url\" AND value<>?");
        $st->bind_param("ss", $url, $url); $st->execute();
        if ($st->affected_rows) echo "[tailticket-legacy:web] helpdesk_url = $url\n";'
    fi
    exec apache2-foreground
    ;;
  cron)
    [ "$state" = "empty" ] && log "in attesa dell'installazione di osTicket"
    until [ "$(php "$LIB/db-state.php" 2>/dev/null)" = "installed" ]; do sleep 10; done
    interval="${CRON_INTERVAL:-300}"
    log "cron di osTicket ogni ${interval}s"
    while :; do
      if su -s /bin/sh www-data -c "php $OST/api/cron.php"; then touch /tmp/cron.ok; else rm -f /tmp/cron.ok; log "cron.php terminato con errore"; fi
      sleep "$interval"
    done
    ;;
  *)
    cd "$OST"
    exec "$@"
    ;;
esac
