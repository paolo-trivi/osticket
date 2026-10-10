# Deploy di TailTicket

Uno stack Docker completo che si avvia con **un comando**:

```bash
git clone https://github.com/paolo-trivi/tailticket tailticket
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
- `caddy-data`: certificati.

## Indirizzi

| URL | Cosa |
|---|---|
| `https://helpdesk.example.com/` | portale clienti TailTicket |
| `…/agent` | pannello agenti TailTicket |
| `…/admin` | area amministrazione TailTicket |
| `…/classic/scp/` | pannello classico osTicket (stessi utenti, stessi dati) |
| `…/classic/api/` | API REST e pipe email di osTicket |

I link del vecchio portale clienti (`/classic/view.php`, `tickets.php?id=…`, `login.php`, `pwreset.php`, `open.php`, `kb/…`) sono reindirizzati alle pagine di TailTicket, così funzionano anche i link nelle email già inviate. Per tenere il portale classico: `TAILTICKET_CLASSIC_PORTAL=keep`.

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
| `TAILTICKET_TIMEZONE` | `Europe/Rome` | fuso orario di osTicket (il DB resta in UTC) |
| `TAILTICKET_AUTO_UPGRADE` | `true` | applica le patch di schema di osTicket all'avvio |
| `TAILTICKET_IMAGE` / `TAILTICKET_LEGACY_IMAGE` | build locale | immagini pubblicate, es. `ghcr.io/paolo-trivi/tailticket:latest` |

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

Senza lo script funziona anche `docker compose up -d`: `COMPOSE_FILE` in `.env` sceglie i file giusti.

## Aggiornamenti e compatibilità del database

`./tailticket update` aggiorna sia TailTicket sia il codice osTicket di `legacy/`. Se la nuova versione di osTicket cambia lo schema:
1. il container `osticket` esegue `php manage.php upgrade` all'avvio;
2. TailTicket controlla la firma dello schema. Se non è tra quelle verificate, resta **in sola lettura** finché non arriva una versione di TailTicket che la supporta.

Il pannello classico continua a funzionare. Dettagli: [docs/compatibility.md](../docs/compatibility.md).

## Collegare un osTicket esistente (modalità attach)

Per chi ha già osTicket 1.18 in produzione e vuole aggiungere TailTicket senza toccarlo:

```bash
./tailticket init --attach --domain nuovo-helpdesk.example.com
# in .env: indicare il DB esistente e il SECRET_SALT del suo include/ost-config.php
# (oppure OST_CONFIG_FILE=/percorso/ost-config.php + OST_CONFIG_PATH_IN_CONTAINER=/etc/osticket/ost-config.php)
./tailticket up
```

Parte solo `tailticket` + `proxy`. Il PHP esistente resta dov'è e continua a gestire cron, email e API.

Indicazioni:
- **Utente MySQL**: serve un utente con privilegi di lettura e scrittura sulle tabelle osTicket. Non servono permessi DDL.
- **DB sulla stessa macchina**: `TAILTICKET_DB_HOST=host.docker.internal`, e MySQL deve accettare connessioni dalla rete Docker.
- **Fuso orario**: `TAILTICKET_DB_TIMEZONE` deve essere il fuso del server MySQL.
- **Nginx al posto di Caddy**: c'è un esempio in [attach/nginx.conf.example](attach/nginx.conf.example) (TailTicket sotto `/app`, build con `NEXT_BASE_PATH=/app`). Deve sovrascrivere `X-Real-IP` e `X-Forwarded-For` con `$remote_addr` (vedi [SECURITY.md](../SECURITY.md), "Reverse proxy e IP del client").

## Sicurezza

- **Porte**: solo il proxy pubblica porte. DB, PHP e TailTicket sono raggiungibili solo sulla rete interna di Docker. Mailpit ascolta solo su `127.0.0.1` e si attiva solo per le prove in locale.
- **IP del client**: Caddy lo passa in `X-Real-IP` e non si fida degli `X-Forwarded-For` ricevuti (salvo `TAILTICKET_TRUSTED_PROXIES`). Non pubblicare la porta 3000 di TailTicket: senza il proxy l'IP non è attendibile.
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
| build lenta o bloccata dietro un proxy aziendale | `TAILTICKET_BUILD_CA=/percorso/ca.crt` in `.env` (passata come secret, non resta nelle immagini) |
