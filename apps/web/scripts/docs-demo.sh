#!/usr/bin/env bash
# Stack demo per gli screenshot della documentazione (docs/assets/screenshots, vedi docs-screenshots.mjs).
# È una copia di deploy/ fuori dal repo, con progetto compose, porte, volumi e immagini propri: non tocca
# gli altri stack (tailticket, tailticket-attach, …) né l'immagine tailticket:local.
#
# Uso: apps/web/scripts/docs-demo.sh up|reset|down|status
#   up      crea o aggiorna la cartella demo (deploy/ e legacy/ copiati, apps/ collegata), ricostruisce le immagini
#           col codice attuale del repo, avvia lo stack integrato (modalità full) e, al primo avvio, semina i dati
#           di dev/seed.php (agenti, utenti, ticket, task, FAQ)
#   reset   cancella i dati della demo (solo i volumi del progetto demo) e rifà up: installazione pulita + seed
#   down    ferma la demo (i dati restano nei volumi)
#   status  stato dei servizi
# Variabili: DEMO_DIR (default ../tailticket-collaudo/demo accanto al repo), DEMO_PROJECT (tailticket-demo),
#   DEMO_HTTP_PORT (28080), DEMO_HTTPS_PORT (28443), DEMO_MAILPIT_PORT (28025), DEMO_TICKETS (60).
# La password dell'admin (TAILTICKET_ADMIN_PASSWORD) è generata in $DEMO_DIR/deploy/.env e non viene stampata;
# agenti e clienti del seed hanno la password di sviluppo di dev/seed.php.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-$(dirname "$REPO")/tailticket-collaudo/demo}"
PROJECT="${DEMO_PROJECT:-tailticket-demo}"
HTTP_PORT="${DEMO_HTTP_PORT:-28080}"
HTTPS_PORT="${DEMO_HTTPS_PORT:-28443}"
MAILPIT_PORT="${DEMO_MAILPIT_PORT:-28025}"
TICKETS="${DEMO_TICKETS:-60}"
DEPLOY="$DEMO_DIR/deploy"

say() { echo "> $*"; }
die() { echo "x $*" >&2; exit 1; }
dc() { (cd "$DEPLOY" && docker compose --env-file .env "$@"); }
# chiave di .env impostata come fa ./tailticket (anche se commentata in .env.example)
envset() { K="$1" V="$2" perl -i -pe 's/^#? ?\Q$ENV{K}\E=.*/$ENV{K}=$ENV{V}/' "$DEPLOY/.env"; grep -qE "^$1=" "$DEPLOY/.env" || echo "$1=$2" >>"$DEPLOY/.env"; }
envget() { grep -E "^$1=" "$DEPLOY/.env" | tail -1 | cut -d= -f2-; }
prefix() { local p; p="$(envget TAILTICKET_TABLE_PREFIX)"; echo "${p:-ost_}"; }
sql() { dc exec -T db sh -c 'exec mariadb -N -B -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"'; }
# mai un "down -v" su un progetto che non sia quello della demo
check_project() {
  local name; name="$(dc config 2>/dev/null | sed -n 's/^name: //p' | head -1)"
  [[ "$name" == "$PROJECT" ]] || die "progetto compose inatteso: '$name' (atteso $PROJECT)"
}

sync_dir() {
  mkdir -p "$DEPLOY"
  # la build di Docker non segue i link simbolici dentro il contesto: legacy/ va copiata; apps/ è il contesto stesso
  ln -sfn "$REPO/apps" "$DEMO_DIR/apps"
  rsync -a --delete --exclude .env --exclude .state/ --exclude backups/ "$REPO/deploy/" "$DEPLOY/"
  rsync -a --delete --exclude include/ost-config.php --exclude '.git*' "$REPO/legacy/" "$DEMO_DIR/legacy/"
}

init_env() {
  [[ -f "$DEPLOY/.env" ]] && return 0
  (cd "$DEPLOY" && ./tailticket init >/dev/null)
  envset COMPOSE_PROJECT_NAME "$PROJECT"
  envset TAILTICKET_HTTP_PORT "$HTTP_PORT"
  envset TAILTICKET_HTTPS_PORT "$HTTPS_PORT"
  envset TAILTICKET_MAILPIT_PORT "$MAILPIT_PORT"
  envset TAILTICKET_URL "http://localhost:$HTTP_PORT"
  envset TAILTICKET_IMAGE "tailticket:demo"
  envset TAILTICKET_LEGACY_IMAGE "tailticket-legacy:demo"
  say "creato $DEPLOY/.env (progetto $PROJECT, http://localhost:$HTTP_PORT)"
}

seed() {
  local admin
  admin="$(envget TAILTICKET_ADMIN_USER)"; admin="${admin:-ttadmin}"
  # demo: niente cambio password obbligatorio al primo accesso dell'admin
  echo "UPDATE ${PREFIX}staff SET change_passwd=0 WHERE username='$admin';" | sql
  if [[ "$(echo "SELECT COUNT(*) FROM ${PREFIX}staff WHERE username='mrossi';" | sql)" != 0 ]]; then
    say "dati demo già presenti (reset per ricrearli)"; return 0
  fi
  # il cron di osTicket marcherebbe come scaduti i ticket retrodatati dal seed prima del ritocco delle date
  dc stop cron >/dev/null
  say "seed: $TICKETS ticket"
  dc cp "$REPO/apps/web/dev/seed.php" osticket:/tmp/seed.php
  dc exec -T -u www-data osticket php /tmp/seed.php /var/www/html/classic "$TICKETS"
  demo_extras
  demo_dates
  dc start cron >/dev/null
}

# Ritocchi della demo con il codice di osTicket: via il ticket di benvenuto dell'installer, account del portale per la
# cliente degli screenshot (password di sviluppo degli agenti di dev/seed.php)
demo_extras() {
  local pw; pw="$(sed -n "s/.*setPassword('\([^']*\)').*/\1/p" "$REPO/apps/web/dev/seed.php" | head -1)"
  [[ -n "$pw" ]] || die "password di sviluppo non trovata in dev/seed.php"
  dc exec -T -u www-data -e DEMO_EMAIL="${DEMO_CLIENT_EMAIL:-f.romano@ospedale.example}" -e DEMO_PW="$pw" osticket \
    sh -c 'cat >/tmp/demo-extras.php && php /tmp/demo-extras.php' <<'PHP'
<?php
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED & ~E_USER_DEPRECATED);
$_SERVER += ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'localhost', 'REQUEST_URI' => '/scp/index.php', 'SCRIPT_NAME' => '/scp/index.php'];
chdir('/var/www/html/classic');
require_once 'bootstrap.php';
Bootstrap::loadConfig(); Bootstrap::defineTables(TABLE_PREFIX); Bootstrap::loadCode(); Bootstrap::connect();
$ost = osTicket::start();
foreach (Ticket::objects()->filter(['cdata__subject' => 'osTicket Installed!']) as $t) { $t->delete(); echo "ticket di benvenuto eliminato\n"; }
$user = User::lookupByEmail(getenv('DEMO_EMAIL'));
if (!$user) { fwrite(STDERR, "utente non trovato\n"); exit(1); }
if ($user->getAccount()) { echo "account del portale già presente\n"; exit(0); }
$pw = getenv('DEMO_PW'); $e = [];
UserAccount::register($user, ['passwd1' => $pw, 'passwd2' => $pw, 'timezone' => 'Europe/Rome', 'backend' => ''], $e);
echo $e ? 'account: '.json_encode($e)."\n" : "account del portale creato\n";
PHP
}

# Date verosimili: il seed sposta i ticket indietro di giorni interi, quindi tutto ha l'ora del seed e messaggi e risposte
# lo stesso minuto. Qui ogni ticket parte in orario di lavoro (08–17 a Roma; il DB è in UTC), i messaggi si susseguono a
# distanza di circa un'ora, gli eventi seguono i messaggi; le scadenze SLA dei ticket aperti non scaduti dal seed vanno
# nel futuro (altrimenti il cron li marcherebbe tutti come scaduti).
demo_dates() {
  local P="$PREFIX"
  sql <<SQL
CREATE TEMPORARY TABLE demo_t AS
  SELECT t.ticket_id, th.id AS thread_id,
         LEAST(DATE(t.created) + INTERVAL (360 + (t.ticket_id * 37) % 540) MINUTE, NOW() - INTERVAL (240 + (t.ticket_id * 37) % 120) MINUTE) AS start
  FROM ${P}ticket t JOIN ${P}thread th ON th.object_type = 'T' AND th.object_id = t.ticket_id;
CREATE TEMPORARY TABLE demo_e AS
  SELECT e.id, d.start + INTERVAL IF(e.r = 0, 0, e.r * 50 + e.id % 15) MINUTE AS ts
  FROM (SELECT id, thread_id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id) - 1 AS r FROM ${P}thread_entry) e
  JOIN demo_t d ON d.thread_id = e.thread_id;
UPDATE ${P}thread_entry e JOIN demo_e x ON x.id = e.id SET e.created = x.ts, e.updated = x.ts;
CREATE TEMPORARY TABLE demo_last AS
  SELECT thread_id, MAX(created) AS last, MAX(IF(type = 'M', created, NULL)) AS msg, MAX(IF(type = 'R', created, NULL)) AS resp
  FROM ${P}thread_entry GROUP BY thread_id;
UPDATE ${P}thread_event ev JOIN demo_t d ON d.thread_id = ev.thread_id JOIN ${P}event k ON k.id = ev.event_id
  LEFT JOIN demo_last l ON l.thread_id = ev.thread_id
  SET ev.timestamp = CASE k.name WHEN 'created' THEN d.start WHEN 'assigned' THEN d.start + INTERVAL 6 MINUTE
                     ELSE COALESCE(l.last, d.start) + INTERVAL 25 MINUTE END
  WHERE ev.thread_type = 'T';
UPDATE ${P}thread th JOIN demo_t d ON d.thread_id = th.id LEFT JOIN demo_last l ON l.thread_id = th.id
  SET th.created = d.start, th.lastmessage = l.msg, th.lastresponse = l.resp;
CREATE TEMPORARY TABLE demo_ev AS
  SELECT ev.thread_id, MAX(ev.timestamp) AS last, MAX(IF(k.name = 'closed', ev.timestamp, NULL)) AS closed
  FROM ${P}thread_event ev JOIN ${P}event k ON k.id = ev.event_id GROUP BY ev.thread_id;
UPDATE ${P}ticket t JOIN demo_t d ON d.ticket_id = t.ticket_id
  LEFT JOIN demo_last l ON l.thread_id = d.thread_id LEFT JOIN demo_ev v ON v.thread_id = d.thread_id
  SET t.created = d.start,
      t.updated = GREATEST(COALESCE(l.last, d.start), COALESCE(v.last, d.start)),
      t.lastupdate = GREATEST(COALESCE(l.last, d.start), COALESCE(v.last, d.start)),
      t.closed = IF(t.closed IS NULL, NULL, COALESCE(v.closed, t.closed)),
      t.duedate = NULL,
      t.est_duedate = IF(t.isoverdue = 1 OR t.closed IS NOT NULL, DATE(d.start) + INTERVAL 1 DAY, DATE(NOW()) + INTERVAL (1 + t.ticket_id % 4) DAY)
                      + INTERVAL (360 + (t.ticket_id * 53) % 540) MINUTE;
-- l'evento "deleted" del ticket di benvenuto comparirebbe nel grafico della dashboard
DELETE ev FROM ${P}thread_event ev JOIN ${P}event k ON k.id = ev.event_id WHERE k.name = 'deleted';
SQL
  say "date dei ticket ritoccate"
}

cmd_up() {
  sync_dir
  init_env
  check_project
  (cd "$DEPLOY" && ./tailticket up)
  PREFIX="$(prefix)"
  seed
  say "demo pronta: http://localhost:$HTTP_PORT (admin $(envget TAILTICKET_ADMIN_USER), password in $DEPLOY/.env)"
}

case "${1:-}" in
  up) cmd_up ;;
  reset)
    [[ -f "$DEPLOY/.env" ]] || die "manca $DEPLOY/.env: usa up"
    check_project
    dc --profile mail down -v --remove-orphans
    cmd_up
    ;;
  down) check_project; dc --profile mail down ;;
  status) dc ps ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
