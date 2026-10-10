# Deploy di TailTicket

Uno stack Docker completo che si avvia con **un comando**:

```bash
git clone https://github.com/paolo-trivi/TailTicket tailticket
cd tailticket/deploy
./tailticket up
```

Alla fine il comando stampa gli indirizzi e le credenziali dell'amministratore iniziale.

## Requisiti

- Linux, macOS o Windows con WSL2.
- Docker Engine 24+ con Docker Compose v2 (`docker compose`).
- 2 GB di RAM, 5 GB di disco.
- Per HTTPS automatico: un nome di dominio che punta al server e le porte 80/443 raggiungibili da internet.

## Cosa parte

| Servizio | Immagine | Ruolo |
|---|---|---|
| `proxy` | `caddy:2.10.2` | **unico ingresso** (porte 80/443): HTTPS, `/classic/…` → osTicket, tutto il resto → TailTicket; passa l'IP del client in `X-Real-IP` |
| `tailticket` | `apps/web/Dockerfile` | la nuova interfaccia: portale clienti `/`, agenti `/agent`, admin `/admin` |
| `osticket` | `deploy/osticket/Dockerfile` (PHP 8.3 + Apache) | pannello classico in `/classic/`; API REST e pipe email in `/classic/api/` |
| `cron` | stessa immagine di `osticket` | `php api/cron.php` ogni 5 minuti: fetch email, SLA/scadenze, pulizie |
| `db` | `mariadb:11.4.12` | database osTicket (charset utf8 come richiesto da osTicket) |
| `mailpit` | `axllent/mailpit:v1.29.7` (profilo `mail`) | server email di prova, **solo per le prove in locale**: cattura tutte le email, interfaccia senza password su `http://127.0.0.1:8025` |

Le immagini hanno versioni fisse: si aggiornano modificando `compose.yaml` (e `compose.attach.yaml`), non a ogni `pull`.

Al primo avvio con database vuoto:
1. il container `osticket` **installa osTicket** con l'installer originale (admin, nome dell'helpdesk, fuso orario da `.env`);
2. rimuove `setup/`;
3. imposta `helpdesk_url` su `<URL>/classic/`.

Ai riavvii successivi applica gli eventuali aggiornamenti di schema (`php manage.php upgrade`) e non reinstalla nulla.

I dati stanno in volumi Docker:
- `db`: database;
- `osticket-files`: allegati su disco, se si usa un plugin di storage;
- `osticket-plugins`: plugin;
- `caddy-data`: certificati;
- `journal`: registro delle scritture di TailTicket (vedi "Registro delle scritture").

## Indirizzi

| URL | Cosa |
|---|---|
| `https://helpdesk.example.com/` | portale clienti TailTicket |
| `…/agent` | pannello agenti TailTicket |
| `…/admin` | area amministrazione TailTicket |
| `…/classic/scp/` | pannello classico osTicket (stessi utenti, stessi dati) |
| `…/classic/api/` | API REST e pipe email di osTicket |

I link del vecchio portale clienti (`/classic/view.php`, `tickets.php?id=…`, `login.php`, `pwreset.php`, `open.php`, `kb/…`) sono reindirizzati alle pagine di TailTicket, così funzionano anche i link nelle email già inviate; lo stesso vale per il link con token delle email agli agenti (`/classic/scp/pwreset.php?token=…`, benvenuto e reset password), mentre il resto del pannello classico non cambia. Per tenere il portale classico: `TAILTICKET_CLASSIC_PORTAL=keep`.

## Configurazione

`./tailticket init` crea `deploy/.env` partendo da [.env.example](.env.example) e genera segreti casuali:
- `TAILTICKET_SECRET_SALT`;
- `TAILTICKET_SESSION_SECRET`;
- password del database;
- password dell'admin iniziale.

```bash
./tailticket init --domain helpdesk.example.com            # HTTPS automatico (Let's Encrypt)
./tailticket init --domain 192.168.1.20 --https internal    # rete interna: certificato della CA di Caddy
./tailticket init                                           # prova in locale: http://localhost (con Mailpit)
```

Mailpit (profilo `mail`) si attiva solo con `localhost`: con un dominio le email partono dagli account SMTP di osTicket o da `TAILTICKET_SMTP_URL`. `--mail` lo forza anche con un dominio, solo per prove (le email non vengono consegnate e la sua interfaccia non ha password).

Opzioni utili di `.env`:

| Variabile | Default | Note |
|---|---|---|
| `TAILTICKET_URL` | `http://localhost` | URL pubblico; serve per i link nelle email |
| `TAILTICKET_HTTPS` | `auto` con un dominio, `off` su localhost | `auto` · `internal` · `off` |
| `TAILTICKET_HTTP_PORT` / `TAILTICKET_HTTPS_PORT` | `80` / `443` | porte pubblicate dal proxy |
| `TAILTICKET_SMTP_URL` | `smtp://mailpit:1025` su localhost, vuoto con un dominio | relay per le email in uscita: `smtp://utente:password@host:587` (STARTTLS) o `smtps://…:465` |
| `COMPOSE_PROFILES` | `mail` su localhost, vuoto con un dominio | `mail` = Mailpit, solo per le prove |
| `TAILTICKET_TRUSTED_PROXIES` | `127.0.0.1/32` (nessuno) | CIDR di CDN/bilanciatori davanti a Caddy di cui fidarsi per `X-Forwarded-For`; mai `private_ranges` con traffico da reti non fidate |
| `TAILTICKET_TRUSTED_PROXY_HOPS` | `1` | proxy fidati davanti a TailTicket (vedi [SECURITY.md](../SECURITY.md)) |
| `TAILTICKET_MAX_BODY` | `40MB` | dimensione massima di una richiesta (allegati) |
| `TAILTICKET_ADMIN_USER` / `_EMAIL` / `_PASSWORD` | generati | solo per la prima installazione; l'email dell'admin deve differire da `TAILTICKET_SYSTEM_EMAIL` |
| `TAILTICKET_MODE` | vuota (`full`); `readonly` in attach | `readonly` · `operational` · `full`: si cambia con `./tailticket mode` |
| `TAILTICKET_TIMEZONE` | `Europe/Rome` | fuso orario di osTicket (il DB resta in UTC) |
| `TAILTICKET_AUTO_UPGRADE` | `true` | applica le patch di schema di osTicket all'avvio |
| `TAILTICKET_IMAGE` / `TAILTICKET_LEGACY_IMAGE` | build locale | immagini pubblicate, es. `ghcr.io/paolo-trivi/tailticket:1.0.0` (o `:latest`) |

> **Non cambiare `TAILTICKET_SECRET_SALT` dopo l'installazione.** Firma i Message-ID delle email (threading delle risposte) e cifra le password degli account email. Il backup lo conserva.

### Email

- **In uscita**: osTicket (cron, avvisi) e TailTicket usano gli account SMTP configurati in osTicket (Admin → Email). In mancanza, usano il relay di `TAILTICKET_SMTP_URL`.
- **In entrata**: il cron di osTicket legge le caselle IMAP/POP configurate in osTicket. In alternativa si può fare il pipe delle email verso `https://<dominio>/classic/api/tickets.email` con una chiave API.

## Comandi

| Comando | Cosa fa |
|---|---|
| `./tailticket up` | avvia o aggiorna i container (crea `.env` se manca), attende che siano sani, stampa gli indirizzi |
| `./tailticket down` | ferma lo stack; i dati restano |
| `./tailticket status` | stato dei servizi |
| `./tailticket logs [servizio]` | log in tempo reale |
| `./tailticket backup [cartella]` | archivio `tailticket-AAAAMMGG-hhmmss.tar.gz` con dump del DB, file e `.env` |
| `./tailticket restore <archivio> [--with-env]` | ripristino; con `--with-env` anche i segreti |
| `./tailticket update` | backup, `git pull`, ricostruzione delle immagini, riavvio con aggiornamento dello schema |
| `./tailticket doctor` | controlli del collegamento a osTicket; codice d'uscita `1` se la scrittura è bloccata |
| `./tailticket mode [readonly\|operational\|full]` | mostra o cambia la modalità di scrittura (vedi la modalità attach) |
| `./tailticket readonly` | interruttore d'emergenza: TailTicket in sola lettura, senza conferme |
| `./tailticket undo [--list \| <id> \| last] [--yes] [--force]` | elenca o annulla le modifiche dell'area admin (vedi "Annullare una modifica dell'area admin") |
| `./tailticket rehearse --dump <file>` / `rehearse down` | prova generale su una copia del DB di produzione, in un progetto separato |

Senza lo script funziona anche `docker compose up -d`: `COMPOSE_FILE` in `.env` sceglie i file giusti (ma senza l'avvio protetto della modalità attach).

Nello stack integrato `TAILTICKET_MODE` non è impostata e vale `full`; il doctor è disponibile (`./tailticket doctor`, `TAILTICKET_DOCTOR_TOKEN` generato da `init` o al primo `up`) ma non obbligatorio.

## Aggiornamenti e compatibilità del database

`./tailticket update` aggiorna sia TailTicket sia il codice osTicket di `legacy/`. Se la nuova versione di osTicket cambia lo schema:
1. il container `osticket` esegue `php manage.php upgrade` all'avvio;
2. TailTicket controlla la firma dello schema. Se non è tra quelle verificate, resta **in sola lettura** (tutte le scritture, in qualsiasi modalità, anche con `TAILTICKET_MODE` non impostata) finché non arriva una versione di TailTicket che la supporta. Lo stesso vale se il doctor trova un problema critico (prefisso, `SECRET_SALT`, fuso orario).

Il pannello classico continua a funzionare. Dettagli: [docs/compatibility.md](../docs/compatibility.md).

## Collegare un osTicket esistente (modalità attach)

Per chi ha già osTicket 1.17 o 1.18 in produzione e vuole aggiungere TailTicket accanto al pannello classico (versioni precedenti: solo consultazione, vedi [versioni supportate](../docs/compatibility.md)). Parte solo `tailticket` + `proxy`: il PHP esistente resta dov'è.

> **Da provare prima su una copia.** Finché la modalità attach in scrittura non è stata collaudata sulla propria installazione, va provata con `./tailticket rehearse` (prova generale, sotto) prima di passare a `operational` in produzione.

### Cosa garantisce TailTicket

- **Parte in sola lettura.** In attach `TAILTICKET_MODE` vale `readonly` finché non la si cambia con `./tailticket mode`, che prima verifica doctor e backup.
- **Nessuna modifica allo schema.** TailTicket non esegue DDL e scrive le stesse righe del PHP ([docs/compatibility.md](../docs/compatibility.md)).
- **Una sola fonte di configurazione.** Con `--config` l'`ost-config.php` dell'osTicket è montato in sola lettura e DB, credenziali, prefisso e `SECRET_SALT` si leggono da lì. Se una variabile `OST_*` ha un valore diverso dal file, TailTicket non parte (l'errore elenca le chiavi, mai i valori).
- **Protezioni automatiche.** Anche in `operational` o `full` la modalità effettiva scende a sola lettura per **tutte** le scritture se la firma dello schema non è verificata o se il doctor trova un problema critico (prefisso delle tabelle, `SECRET_SALT`, fuso orario). In sola lettura le pagine restano consultabili, le azioni sono rifiutate con un messaggio e gli upload rispondono `503`.
- **Avvio protetto.** `./tailticket up` e `./tailticket update` avviano TailTicket in sola lettura, eseguono il doctor e attivano la modalità configurata solo senza blocchi. Con blocchi riportano `.env` a `readonly` (vale anche per i riavvii), lo dicono chiaramente ed escono con codice `3`.

### Cosa resta al PHP

Il PHP continua a fare tutto quello che TailTicket non duplica: **cron** (`api/cron.php`: fetch delle email, SLA e scadenze, pulizie), **email in entrata** (caselle IMAP/POP e pipe), **API REST**, **plugin** (autenticazione LDAP/OAuth, storage, segnali), installer e upgrader. Il cron dell'osTicket esistente deve restare attivo: il doctor lo controlla.

### Le tre modalità

| Modalità | Cosa scrive TailTicket |
|---|---|
| `readonly` (default in attach) | niente: consultazione di ticket, utenti, knowledge base, report, area admin |
| `operational` | lavoro quotidiano: ticket, task, utenti e organizzazioni, portale clienti, profilo, login (lock, allegati, syslog). L'area admin è in sola lettura |
| `full` | tutto, comprese le impostazioni di osTicket dall'area admin (reparti, email, filtri, SLA, agenti), condivise con il pannello classico |

```bash
./tailticket mode                 # modalità in .env, nel container ed effettiva (/api/health), firma dello schema
./tailticket mode operational     # doctor senza blocchi + backup recente + conferma con il nome del DB
./tailticket mode full            # in più, conferma esplicita sull'area admin
./tailticket readonly             # interruttore d'emergenza: sola lettura subito, senza conferme
```

Il passaggio a `operational` o `full` richiede: doctor senza blocchi, un `./tailticket backup` delle ultime 24 ore dello stesso DB (`TAILTICKET_BACKUP_MAX_AGE_HOURS`) e la conferma scrivendo il nome del database. Per l'automazione: `--yes` (e per `full` anche `--confirm-admin`); doctor e backup restano obbligatori. Tornare a una modalità più restrittiva non chiede nulla.

### Installazione

```bash
./tailticket init --attach --domain nuovo-helpdesk.example.com \
  --config /var/www/osticket/include/ost-config.php --db-user tailticket \
  --attachments /var/www/osticket-files \
  --classic-url https://helpdesk.example.com
./tailticket up        # parte in sola lettura ed esegue il doctor
```

| Opzione di `init --attach` | Effetto |
|---|---|
| `--config FILE` | legge `DBHOST`, `DBNAME`, `DBUSER`, `DBPASS`, `TABLE_PREFIX` e `SECRET_SALT` da `ost-config.php` e lo monta in sola lettura; in `.env` non finisce nessuno di questi valori |
| `--db-host H[:P]`, `--db-user U` | indirizzo del DB visto dal container, utente MySQL dedicato (la password si chiede da terminale) |
| `--attachments CARTELLA` | cartella degli allegati su disco (plugin storage-fs), montata in sola lettura |
| `--classic-url URL` | pannello osTicket esistente (pulsante "Apri nel pannello classico") |
| `--smtp URL` | relay SMTP, solo se osTicket usa `mail()` di PHP (nessun account SMTP) |

Senza `--config` lo script chiede da terminale DB, utente, password, prefisso e `SECRET_SALT`, senza valori predefiniti; senza terminale scrive `CHANGE_ME` e `up` si rifiuta di partire finché restano. Viene generato anche `TAILTICKET_DOCTOR_TOKEN`. In attach non c'è Mailpit e `TAILTICKET_SMTP_URL` è vuota: TailTicket usa gli account SMTP configurati in osTicket.

**DB sulla stessa macchina.** Se `DBHOST` è `localhost` (o un socket), dal container il DB si raggiunge come `host.docker.internal`: MySQL deve ascoltare in TCP su un indirizzo raggiungibile dalla rete Docker (`bind-address`) e l'utente deve valere per gli indirizzi dei container (`'utente'@'172.%'`). In questo caso, o con `--db-host`/`--db-user`, il file montato andrebbe in conflitto con l'indirizzo o l'utente del container: lo script **copia** i valori in `.env` (`OST_CONFIG_COPIED_FROM`) invece di montare il file, e a ogni avvio controlla che DB, prefisso e `SECRET_SALT` coincidano ancora con il file. `OST_CONFIG_OVERRIDE` (variabili che vincono di proposito sul file) esiste solo per sviluppo e test: non usarla in produzione.

**`.env` di una versione precedente.** Al primo `up` (o `update`, `mode`) lo script converte le vecchie chiavi `TAILTICKET_DB_*` di un `.env` attach nelle `OST_*`, tiene solo quelle che servono, imposta `TAILTICKET_MODE=readonly` e salva una copia dell'originale in `.state/`. Un'installazione attach che prima scriveva riparte quindi **in sola lettura**: si torna a scrivere con `./tailticket backup` e `./tailticket mode operational`.

### Utente MySQL minimo

Per scrivere serve un utente **senza permessi DDL o amministrativi**: il doctor blocca le scritture se l'utente ha `CREATE`, `ALTER`, `DROP`, `GRANT`, `SUPER` e simili. L'utente di `ost-config.php` di solito li ha (l'installer di osTicket li richiede), quindi in pratica si crea un utente dedicato a TailTicket:

```sql
CREATE USER 'tailticket'@'172.%' IDENTIFIED BY '…';
GRANT SELECT, INSERT, UPDATE, DELETE ON `osticket`.* TO 'tailticket'@'172.%';
```

e lo si indica con `--db-user tailticket` (modalità copia, vedi sopra). In sola lettura basta anche l'utente del PHP. L'utente dedicato basta anche per `./tailticket backup` (dump con `--single-transaction --no-tablespaces`, senza lock). Il doctor legge i permessi effettivi (`SHOW GRANTS FOR CURRENT_USER()`).

### Il doctor

`./tailticket doctor` interroga `/api/doctor` dall'interno del container (con `TAILTICKET_DOCTOR_TOKEN`; il proxy risponde `404` a `/api/doctor` da fuori) e stampa una tabella con livelli `ok`, `warn`, `block`, `info`. Esce con codice `1` se la scrittura è bloccata, `2` se il doctor non risponde.

| Controllo | Cosa verifica |
|---|---|
| Schema | firma `core.schema_signature` tra quelle verificate |
| Prefisso | le tabelle osTicket esistono con `TABLE_PREFIX` |
| `SECRET_SALT` | coerente con i Message-ID già inviati e con le password cifrate degli account email |
| Fuso orario | offset del server MySQL rispetto a `OST_DB_TIMEZONE` |
| Permessi | `GRANT` dell'utente MySQL: privilegi DDL o amministrativi, o permessi mancanti sul DB osTicket, bloccano la scrittura |
| Email in uscita | account SMTP di osTicket o `TAILTICKET_SMTP_URL` |
| Allegati | backend dei file; con allegati su disco, la cartella montata e la lettura di un file reale |
| Plugin, autenticazione | plugin attivi e backend di login che TailTicket non replica |
| Cron | segni di esecuzione del cron dell'osTicket (o dell'auto-cron) |
| Modalità | configurata ed effettiva, con il motivo di un'eventuale sola lettura |

`/api/health` è pubblico: risponde `200` con `{ status: "ok"|"degraded", mode, configuredMode, schema: "verified"|"unverified" }` anche in sola lettura, `503` solo se il DB non risponde. L'healthcheck del container lo usa.

### Allegati su disco

Con il plugin storage-fs i file stanno in una cartella del server di produzione (`<cartella>/<iniziale della chiave>/<chiave>`). Con `--attachments` (o `OST_ATTACHMENTS_HOST_DIR` + `OST_ATTACHMENTS_DIR`) TailTicket la monta **in sola lettura**: legge gli allegati esistenti, mentre i nuovi allegati caricati da TailTicket vanno nel database (backend `D`), come fa osTicket senza plugin. Se la cartella o `ost-config.php` non sono leggibili da tutti, `init` imposta `TAILTICKET_FILES_GID` e il container li legge con quel gruppo. Gli allegati su disco **non** sono nel backup di TailTicket: restano del server di produzione e dei suoi backup.

### Percorso consigliato

```bash
./tailticket init --attach --config …/ost-config.php --db-user tailticket   # 1. configurazione, in sola lettura
./tailticket up                                         # 2. avvio protetto + doctor
./tailticket doctor                                     # 3. nessun BLOCK; leggere i WARN
./tailticket backup                                     # 4. dump del DB di produzione
./tailticket rehearse --dump backups/tailticket-attach-….tar.gz --attachments /var/www/osticket-files
                                                        # 5. prova generale sulla copia, poi rehearse down
./tailticket backup                                     # 6. backup fresco (ultime 24 ore)
./tailticket mode operational                           # 7. scrittura del lavoro quotidiano
./tailticket mode full                                  # 8. solo se serve l'area admin in scrittura
```

### Prova generale (`rehearse`)

```bash
./tailticket rehearse --dump <dump.sql[.gz] | archivio di ./tailticket backup> [--attachments CARTELLA] \
  [--port 18080] [--mail-port 18025] [--mode full] [--upgrade] [--yes]
./tailticket rehearse status | logs [servizio] | doctor | down
```

Alza lo **stack integrato completo** (MariaDB, osTicket classico di `legacy/`, cron, TailTicket, Caddy, Mailpit) in un progetto compose separato, `tailticket-rehearsal`, con volumi, rete e porte propri, pubblicate solo su `127.0.0.1` (da un'altra macchina: `ssh -L 18080:127.0.0.1:18080 -L 18025:127.0.0.1:18025 server`). Non tocca lo stack attach né quello integrato.

1. Importa il dump in un database vuoto, con il `SECRET_SALT` e il prefisso della produzione (dall'archivio di `backup` o dalla configurazione attach). Il container `osticket` non reinstalla (`TAILTICKET_INSTALL=off`: con un DB vuoto si ferma) e non aggiorna lo schema, salvo `--upgrade`.
2. Confronta la firma di schema del dump con quella di `legacy/` (osTicket 1.18.4) e avvisa se è diversa: la prova non riprodurrebbe la produzione. Con una produzione 1.17 conviene `--upgrade`: la copia passa a 1.18 e la prova resta fedele per TailTicket (le scritture sono le stesse sulle due versioni), non per il pannello classico 1.17.
3. **Neutralizza la posta della copia** prima di avviare PHP e cron, dopo una conferma: caselle in entrata (IMAP/POP) disattivate e fetch spento, così nessuna email viene letta o cancellata dalle caselle reali; account SMTP reindirizzati a Mailpit (`mailpit:1025`, senza TLS né autenticazione); `mail()` del PHP e TailTicket senza account verso Mailpit. Se resta un account attivo verso l'esterno la prova non parte.
4. Avvia tutto, esegue il doctor e stampa gli indirizzi: si entra con le credenziali degli agenti di produzione (i plugin, ad esempio LDAP, non ci sono).

`./tailticket rehearse down` ferma la prova e **cancella** i suoi volumi (la copia dei dati di produzione).

### Backup

In attach `./tailticket backup` esegue `mariadb-dump` da un container usa e getta dell'immagine MariaDB fissata in `compose.yaml`, sulla stessa rete di TailTicket e con le credenziali della configurazione (passate su stdin, mai sulla riga di comando). Il dump è in sola lettura: `--single-transaction --skip-lock-tables --quick --routines --no-tablespaces --hex-blob --default-character-set=utf8mb4` (utf8mb4 non perde caratteri anche se qualche tabella lo usa già). Lo script verifica che il dump sia completo e contenga la tabella `config` del prefisso, poi crea `backups/tailticket-attach-AAAAMMGG-hhmmss.tar.gz` (permessi `600`) con `db.sql.gz`, `.env` e una copia di `ost-config.php`, e registra il backup in `.state/last-backup` (il marcatore che `mode` controlla). `./tailticket update` lo esegue sempre per primo. Il ripristino del DB di produzione si fa con gli strumenti dell'osTicket (`gunzip -c db.sql.gz | mariadb <db>`): `restore` in attach si rifiuta.

### Registro delle scritture

TailTicket annota ogni transazione confermata in `/var/lib/tailticket/journal/writes-AAAA-MM-GG.jsonl` (data UTC, volume `journal`): una riga JSON `{ ts, scope, actor?, op?, tables: { tabella: [verbi] } }`, senza valori, testi o dati personali. Serve a sapere che cosa ha scritto TailTicket e quando. Se il registro non è scrivibile l'operazione non fallisce.

```bash
docker compose exec tailticket sh -c 'tail -n 20 /var/lib/tailticket/journal/writes-*.jsonl'
```

### Annullare una modifica dell'area admin

Ogni salvataggio dell'area admin (form, azioni di massa, eliminazioni, tema) è una modifica registrata con le righe prima e dopo, in `/var/lib/tailticket/journal/changes/` (cartella `700`, file `600`: contengono i valori, anche hash delle password e credenziali cifrate, e non sono mai esposti via HTTP; si conservano 30 giorni, al massimo 200 modifiche). Il banner di conferma ha **Annulla modifica**; *Pannello › Modifiche recenti* le elenca con lo stato (annullabile, annullata, non annullabile, in conflitto).

```bash
./tailticket undo                 # elenco (anche --list)
./tailticket undo last            # ultima modifica non annullata: riepilogo, conflitti, conferma con il nome del DB
./tailticket undo 20261010-081530-3f9a --yes   # senza conferma (automazione)
```

L'annullamento riporta le righe ai valori precedenti in una sola transazione ed è a sua volta una modifica (si può rifare annullandola). È rifiutato se le stesse righe sono cambiate dopo, anche dal pannello classico: si annullano prima le modifiche più recenti, oppure `--force` (solo dal CLI) sovrascrive i cambiamenti successivi. Serve `TAILTICKET_MODE=full` con lo schema verificato; funziona anche quando il doctor ha bloccato le scritture, perché un'impostazione admin sbagliata (es. il fuso) è proprio il caso da correggere. Non sono annullabili le operazioni oltre 5000 righe (es. eliminare un reparto o un agente con molti ticket: lo dice il banner) né le scritture non registrabili; email inviate e file su disco restano.

### Emergenza e spegnimento

- **Interruttore d'emergenza**: `./tailticket readonly` ricrea solo il container TailTicket in sola lettura, senza conferme; il pannello classico continua a funzionare.
- **Spegnere TailTicket**: `./tailticket down`. I dati restano un normale DB osTicket: il PHP continua a funzionare come prima, senza migrazioni da annullare (le righe `config` con namespace `nextui.*` il PHP le ignora).

### Altro

- **Fuso orario**: `OST_DB_TIMEZONE` è il fuso del server MySQL; vuota, si ricava dall'offset del DB e il doctor la confronta.
- **Nginx al posto di Caddy**: c'è un esempio in [attach/nginx.conf.example](attach/nginx.conf.example) (TailTicket sotto `/app`, build con `NEXT_BASE_PATH=/app`). Deve sovrascrivere `X-Real-IP` e `X-Forwarded-For` con `$remote_addr` (vedi [SECURITY.md](../SECURITY.md), "Reverse proxy e IP del client") e non esporre `/app/api/doctor`.

## Sicurezza

- **Porte**: solo il proxy pubblica porte. DB, PHP e TailTicket sono raggiungibili solo sulla rete interna di Docker. Mailpit ascolta solo su `127.0.0.1` e si attiva solo per le prove in locale.
- **IP del client**: Caddy lo passa in `X-Real-IP` e non si fida degli `X-Forwarded-For` ricevuti (salvo `TAILTICKET_TRUSTED_PROXIES`). Non pubblicare la porta 3000 di TailTicket: senza il proxy l'IP non è attendibile.
- **Doctor**: `/api/doctor` risponde solo con l'header `X-Doctor-Token` (`TAILTICKET_DOCTOR_TOKEN`, generato da `init`) e il proxy la chiude da fuori (`404`): `./tailticket doctor` la interroga dall'interno del container.
- **Segreto di sessione**: `TAILTICKET_SESSION_SECRET` è generato da `./tailticket init`; TailTicket non parte con un valore di esempio o debole.
- **`.env`**: contiene i segreti, ha permessi `600` ed è escluso da git. Lo stesso vale per i backup.
- **HTTPS**: obbligatorio fuori da localhost, perché i cookie di TailTicket sono `Secure`.
- **Una sola istanza di TailTicket**: codici 2FA, contatori dei tentativi falliti e sessioni revocate al logout sono in memoria. Non scalare il servizio `tailticket` oltre 1 replica.
- **Sessioni**: il logout revoca la sessione sul server; ogni sessione dura al massimo 12 ore dal login, anche con il timeout di inattività disattivato.
- **Admin iniziale**: dopo il primo accesso cambiare la password dell'admin creato dall'installazione (la password resta in `.env` finché non la si toglie).

## Problemi comuni

| Sintomo | Causa e rimedio |
|---|---|
| `tailticket` non diventa sano | `./tailticket logs tailticket`: di solito DB non raggiungibile o `SECRET_SALT` mancante |
| certificato non emesso | il dominio deve puntare al server e le porte 80/443 devono essere aperte. In rete interna: `--https internal` |
| email non inviate | profilo `mail` attivo (finiscono in Mailpit) oppure `TAILTICKET_SMTP_URL` errato: controllare `./tailticket logs cron` |
| "schema non verificato" in Admin → Dashboard | il DB è stato aggiornato a una versione di osTicket non ancora verificata: TailTicket è in sola lettura (vedi sopra) |
| attach: `up` esce con "modalità … NON attivata" | il doctor ha trovato blocchi: `./tailticket doctor`, risolverli, poi `./tailticket mode operational` |
| attach: "Configurazione in conflitto" nei log | una variabile `OST_*` di `.env` è diversa da `ost-config.php` montato: toglierla, oppure `init --attach --force` con `--db-host`/`--db-user` (modalità copia) |
| attach: "non corrisponde più a …ost-config.php" | in modalità copia DB, prefisso o `SECRET_SALT` del file sono cambiati: aggiornare `.env` |
| attach: privilegi DDL nel doctor | l'utente MySQL ha più permessi del necessario: utente dedicato con `SELECT, INSERT, UPDATE, DELETE` (`--db-user`) |
| build lenta o bloccata dietro un proxy aziendale | `TAILTICKET_BUILD_CA=/percorso/ca.crt` in `.env` (passata come secret, non resta nelle immagini) |
