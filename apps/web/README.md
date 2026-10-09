# osTicket Next — nuovo frontend Next.js sul database di osTicket

Interfaccia Next.js 16 (App Router, React 19, TypeScript strict, Tailwind v4, template TailAdmin brandizzato osTicket) che lavora **sullo stesso database MySQL di osTicket 1.18.4**, in contemporanea con il pannello PHP classico. Ogni scrittura produce **le stesse righe** (e le stesse email) del PHP, verificate con test differenziali PHP vs TypeScript.

Documentazione:
- knowledge base di osTicket: `../docs/reverse-engineering/` (doc 00–17);
- contratto di scrittura (righe scritte per ogni operazione): doc 17, generato anche da `docs/contract/*.md`;
- stato del lavoro e ripartenza: `RESTART.md`; regole per chi sviluppa: `AGENTS.md`, `docs/parallel-brief.md`.

## Regole di coesistenza (da rispettare sempre)
1. **Nessuna modifica allo schema** del DB osTicket: niente migrazioni, ALTER o tabelle nuove. La configurazione propria di Next sta solo in righe `config` con namespace `nextui.*`.
2. Ogni scrittura produce **le stesse righe** del PHP, effetti collaterali compresi (`thread_event`, `*__cdata`, `form_entry(_values)`, `_search`, `attachment/file`, `syslog`, `draft`, `lock`, `sequence`…) e le stesse email (template, header, Message-ID firmati).
   - Le stranezze del PHP si replicano e si annotano nel codice.
   - I bug di **sicurezza o permessi** del PHP **non** si replicano: si applica la regola più stretta e la si annota (elenco nel doc 17 §3 e nel doc 14).
3. Stesso formato dei dati: datetime nel fuso del server MySQL (`NOW()` lato SQL), sessione MySQL come il PHP (`SQL_MODE=''`, utf8), JSON come `json_encode`, niente caratteri a 4 byte.
4. Stessa crittografia (bcrypt phpass, `SECRET_SALT` per Message-ID, token e password cifrate degli account email), letta da `ost-config.php`.
5. I processi batch (cron, fetch email, API `/api/*.php`, installer, upgrade) **restano al PHP**.

## Funzioni

### Pannello agenti (`/agent`)
| Area | Funzioni |
|---|---|
| Accesso | login (username o email), 2FA via email, password dimenticata e reset con token, blocco per tentativi falliti con avviso all'admin, logout |
| Dashboard | contatori e grafici dei ticket |
| Code e ricerca | code personali e di sistema con stessi criteri, visibilità, ordinamenti e contatori del PHP; ricerca full-text; export CSV delle code |
| Vista ticket | thread con versioni ed eventi, risposta e nota con allegati, bozze, lock, risposte predefinite, firme |
| Azioni sul ticket | assegna (agente/team), prendi in carico, rilascia, trasferisci, referral (aggiunta/rimozione), cambio stato, riapri, segna risposto/scaduto, ban/unban email, modifica (campi, topic, SLA, scadenza, proprietario, origine), collaboratori, merge/link, eliminazione, modifica di una voce del thread |
| Lista ticket | azioni di massa (stato, assegnazione, presa in carico, trasferimento, merge/link, eliminazione) |
| Nuovo ticket | `/agent/tickets/new`: utente esistente o nuovo, topic con form dinamici, reparto, SLA, scadenza, assegnatario, risposta iniziale o nota, allegati, filtri e numerazione come il PHP |
| Task | lista, creazione (anche da ticket), nota/risposta, assegnazione, trasferimento, chiusura/riapertura, campi, eliminazione, massa |
| Utenti e organizzazioni | CRUD con form dinamici, import CSV, account utente (registrazione, conferma, blocco, reset), collegamento utente-organizzazione, massa |
| KB e risposte predefinite | consultazione |
| Profilo | preferenze, firma, password con policy, configurazione 2FA |

### Area amministrazione (`/admin`, solo amministratori)
- **Impostazioni**: azienda, sistema, ticket, task, agenti, utenti, KB, email; tema della nuova interfaccia (colori, font, densità, loghi di osTicket).
- **Gestione**: reparti, help topic, SLA, orari e festività, agenti, team, ruoli e permessi.
- **Sistema**: account email (password cifrate come il PHP), template email, ban list, diagnostica (email di prova), filtri dei ticket, form personalizzati e liste, pagine di contenuto, code, chiavi API, log di sistema, informazioni di sistema, plugin.

### Portale clienti (root `/`)
- Home con pagine di contenuto, KB pubblica (categorie, FAQ, ricerca).
- Accesso: login con email e password, registrazione e conferma, reset password, accesso da ospite con numero ticket ed email, link con token `?auth=` delle email.
- I miei ticket (propri, da collaboratore, dell'organizzazione se condivisa), vista ticket con allegati, risposta (`Ticket::postMessage`), modifica dei campi consentiti, apertura di un nuovo ticket con form dinamici e allegati, profilo.

## Struttura
```
src/
  app/[locale]/(staff)/agent/   pannello agenti
  app/[locale]/(staff)/admin/   area amministrazione
  app/[locale]/(client)/        portale clienti
  app/api/                      upload (agenti/clienti), file allegati, export CSV, loghi
  components/                   UI TailAdmin per area (tickets/, people/, admin/, portal/, forms/dynamic/…)
  server/
    env.ts                      configurazione condivisa (ost-config.php / variabili d'ambiente)
    db/                         Kysely + mysql2, prefisso tabelle, tipi generati, fuso orario
    config/                     tabella config (namespace core, staff.<id>, nextui.*…)
    auth/                       password phpass, sessioni agenti e clienti, 2FA, tentativi falliti
    domain/<modulo>/            servizi di dominio (port delle classi include/class.*.php)
    mail/                       mailer, template, variabili %{…}, Message-ID
    format/, crypto/, system/   utility compatibili con Format::, Crypto::, syslog
dev/                            ambiente di sviluppo (MariaDB + osTicket PHP + Mailpit) e fixture dei test
deploy/                         docker-compose e nginx di esempio
test/unit/                      unit test
test/diff/                      test differenziali PHP vs TypeScript (harness, runner PHP, operazioni per area)
```

## Sviluppo
```bash
npm ci
# osTicket PHP di riferimento sulla fixture dei test (MariaDB e PHP 8.3 richiesti)
OST_DEV=/home/user/ost-dev bash dev/ci-setup.sh
npm run dev:services          # MariaDB, Mailpit (SMTP 1025, UI 8025), osTicket PHP (:8080)

cp .env.example .env.local    # OST_CONFIG_PATH, APP_SESSION_SECRET, OST_PHP_URL
npm run dev                   # http://127.0.0.1:3000 (portale), /agent, /admin
```
Credenziali di sviluppo (password `Passw0rd!dev`): admin `devadmin`; agenti `mrossi`, `lbianchi`, `gverdi`, `aesposito`.

### Verifiche
```bash
npm run lint && npm run typecheck && npm test     # lint, tipi, unit
npm run test:diff                                 # test differenziali PHP vs TypeScript (DB + email via Mailpit)
npx next build
```
I test differenziali clonano il DB di sviluppo, eseguono la stessa operazione con il codice PHP originale (`test/diff/php/runner.php` + `test/diff/php/ops/*.php`) e con il servizio TypeScript su due copie, e confrontano **tutte le tabelle** e le email ricevute da Mailpit. `OST_DIFF_TAG` separa i DB per lavorare in parallelo. Per vedere cosa scrive il PHP: `node test/diff/trace.mjs '{"op":"ticket.reply","args":{…}}'`.

## Deploy

### Docker
```bash
docker build -t tailticket apps/web                       # app alla radice di un host dedicato
docker build -t tailticket --build-arg NEXT_BASE_PATH=/app apps/web   # app sotto /app
```
Variabili d'ambiente principali:
| Variabile | Uso |
|---|---|
| `OST_CONFIG_PATH` | `include/ost-config.php` di osTicket, montato in sola lettura (DB, prefisso, `SECRET_SALT`) |
| `OST_DB_HOST`, `OST_DB_*` | sovrascrivono i valori di `ost-config.php` (es. host del DB visto dal container) |
| `OST_DB_TIMEZONE` | fuso del server MySQL (consigliato, es. `Europe/Rome`) |
| `APP_SESSION_SECRET` | segreto (≥ 32 caratteri) dei cookie di sessione di Next |
| `OST_SMTP_URL` | relay SMTP se gli account email di osTicket non hanno SMTP (altrimenti sendmail/msmtp) |
| `OST_PHP_URL` | URL del pannello PHP (pulsante "Apri nel pannello classico") |
| `NEXT_BASE_PATH` | (build) sotto-percorso di pubblicazione, es. `/app` |

`deploy/docker-compose.yml` avvia la app su `127.0.0.1:3000` e, con il profilo `proxy`, un nginx di esempio:
```bash
OST_CONFIG_FILE=/var/www/osticket/include/ost-config.php APP_SESSION_SECRET=… \
  docker compose -f deploy/docker-compose.yml --profile proxy up -d --build
```

### Reverse proxy (nginx)
`deploy/nginx.conf` mostra la coesistenza su un unico host: `/app/…` → Next (build con `NEXT_BASE_PATH=/app`), tutto il resto → osTicket PHP invariato (scp/, portale, api/, cron). In alternativa Next può stare su un sottodominio dedicato senza base path.
- Next va esposto **solo dietro il proxy**: l'IP del client si legge da `X-Forwarded-For`.
- I cookie di sessione sono `Secure` in produzione: serve HTTPS.
- Le email continuano a puntare agli URL del PHP (`scp/tickets.php`, `view.php`, `pwreset.php`…). Per far servire il portale clienti a Next, `deploy/nginx.conf` contiene i redirect (commentati) da attivare.

## CI
Workflow GitHub Actions `.github/workflows/ci.yml`:
- job **quality**: lint, typecheck, unit test, `next build`;
- job **differential**: installa MariaDB e PHP 8.3, ricrea osTicket dalla fixture (`dev/ci-setup.sh`, `dev/fixtures/osticket-dev.sql.gz`) con Mailpit ed esegue `npm run test:diff`.

Se cambia il DB di sviluppo su cui si basano i test, rigenerare la fixture:
`mysqldump -u root --single-transaction --skip-dump-date --no-tablespaces osticket | gzip -9n > dev/fixtures/osticket-dev.sql.gz`.

## Limiti noti
- Restano al PHP: cron, fetch delle email, API REST, installer/upgrade, plugin (Next non esegue codice PHP), backend di autenticazione esterni (LDAP, OAuth), OAuth2 degli account email, caricamento di loghi/sfondi, modifiche dei form che richiedono DDL sulle tabelle `*__cdata`.
- Non implementati: captcha del portale (con `enable_captcha` attivo gli ospiti non possono aprire ticket da Next), stampa PDF, "gestisci form" del ticket, "modifica e reinvia", inserimento di risposte predefinite nel form di apertura, traduzioni dei contenuti.
- Codici 2FA e contatori dei tentativi falliti sono in memoria del processo: con più istanze di Next o dopo un riavvio si azzerano.
- Il testo alternativo (text/plain) delle email è generato con `html-to-text` e può differire nell'impaginazione da quello del PHP (HTML, header e Message-ID sono identici).
- Corpi in testo semplice (rich text disattivato): la chiusura dei tag sbilanciati di `Format::html_balance` (libxml) non è replicata.
- Le date nei template seguono ICU ≥ 72 (spazio stretto prima di AM/PM), come il PHP 8.3 della CI.
