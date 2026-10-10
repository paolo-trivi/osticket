# Changelog

Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Versioni secondo [SemVer](https://semver.org/lang/it/).

## [Non rilasciato]

Correzioni dal collaudo visivo su un'installazione pulita (portale, pannello agenti, area admin, scansione del codice).

### Corretto
- **Redirect dietro il reverse proxy**: i route handler puntavano all'host interno del container (`http://0.0.0.0:3000`). Si rompevano il link di accesso al ticket via email, la conferma dell'account cliente, la conferma del reset e i loghi predefiniti. Ora usano una `Location` relativa.
- **Impostazioni email**: su un'installazione pulita "Accetta email da utenti non registrati", "Aggiungi i destinatari in copia come collaboratori" e "Verifica record MX" apparivano spente. Salvare la pagina le spegneva davvero e le email dei nuovi utenti venivano rifiutate. Ora valgono i default del PHP (`class.config.php`), verificati da un test.
- **Form che non perdono i dati**: dopo un errore di validazione i valori restano, mentre con `<form action>` React 19 azzerava il form a fine azione. Riguarda:
  - tutti i form admin e di sistema;
  - "Modifica ticket", composer di ticket e task, dialog delle azioni e di massa, collaboratori, referral;
  - profilo agente, 2FA e recupero password;
  - portale: risposta con allegati, registrazione e profilo, modifica ticket, reset password.

  Una sola implementazione: `src/lib/submit-keeping-values.ts`. Anche gli allegati già caricati in "Nuovo ticket" e "Apri ticket" restano.
- **Invio nei campi di ricerca**: in "Cerca utente", "Collaboratori (Cc)", "Gestisci collaboratori" e "Unisci" premere Invio inviava l'intero form (es. ticket creato senza Cc). Ora sceglie il suggerimento evidenziato, con navigazione da tastiera (combobox ARIA). In "Unisci" si aggiunge un ticket cercandolo per numero, come nel PHP.
- **Thread ed eventi**:
  - l'evento di chiusura e il cambio di stato mostrano il nome dello stato;
  - i riferimenti salvati come `[id, nome]` (es. assegnatario) non restano più vuoti;
  - tradotti "unlinked" e l'origine ("via Telefono");
  - collaboratori, proprietario, argomento, SLA, scadenza e campi modificati descritti come nel PHP;
  - la vista task mostra i suoi eventi.
- **Esiti mostrati dopo ogni azione**:
  - ticket: assegnazione, trasferimento, chiusura (anche da risposta), eliminazione, creazione;
  - task, utenti e organizzazioni: creazione, modifica, importazione, blocco, reset, eliminazione;
  - profilo e modifica ticket del portale.

  Gli avvisi non si impilano più, e gli esiti in query string dell'area admin non si sommano ai nuovi. Il banner di esito o errore dei form lunghi viene portato in vista.
- **Nuovo ticket da agente**:
  - "Assegna a" propone gli stessi agenti e team del PHP; prima un team senza membri faceva fallire l'assegnazione senza avviso;
  - in "Utente esistente" senza scelta compare "Seleziona un utente";
  - `?uid=` preseleziona l'utente, ed è collegato dalla pagina utente.
- **Scadenza**: creazione, modifica e modifica del singolo campo usano tutte il fuso dell'agente. Il PHP mostra il fuso dell'agente ma rilegge in UTC, spostando l'ora a ogni salvataggio (doc 17).
- **SLA**:
  - in "Modifica ticket" lo SLA disattivato del ticket resta tra le opzioni e non viene rimosso al salvataggio;
  - nell'admin un periodo di tolleranza non intero dà un errore invece di un falso "salvato".
- **Area admin**:
  - "Versione di osTicket" presa dalla firma dello schema se manca `bootstrap.php`;
  - conteggio della lista di sistema "Ticket Status";
  - opzioni allineate al PHP (argomenti e padre solo attivi, stati e SLA con "(disattivato)");
  - in "Sistema" i formati avanzati compaiono solo con "Avanzato" e le lingue hanno il nome per esteso;
  - la descrizione delle voci d'orario indica il giorno;
  - tolta la nota tecnica sul campo "visibile" degli agenti.
- **Task**: i contatori di `/agent/tasks?ticket=N` contano solo i task del ticket; con un assegnatario il pulsante dice "Riassegna".
- **Dashboard**: il grafico include i giorni senza eventi e mostra i marcatori, i colori della legenda non si ripetono e i nomi degli eventi sono tradotti.
- **Menu e navigazione**: i menu a tendina restano nell'area del contenuto (finivano sotto la sidebar).
- **Sidebar**: si apre ed evidenzia il gruppo che contiene la pagina, compresi dettaglio ticket, coda predefinita e ricerca. Resta attiva solo la voce più specifica. Niente più flash grigio né animazione a ogni caricamento in tema scuro.
- **Portale**: "Stato del ticket" risulta attivo.
- **Date**: nel fuso dell'agente e con un formato coerente fra liste e viste (agenti, ruoli, orari, SLA, ban list, code, utenti, task, voce del thread).
- **Pagina 404**: gli URL inesistenti mostrano la pagina localizzata invece di quella predefinita di Next.
- **Board**: due cambi ravvicinati di colonne e swimlane vengono applicati entrambi; all'apertura parte dalla prima colonna e i filtri vanno a capo.
- **Testi e traduzioni**:
  - plurali di utenti, organizzazioni e riepilogo agenti;
  - descrizioni dei permessi tradotte;
  - intestazioni "Date Closed"/"Closed By" e nome della coda nell'export;
  - messaggi specifici al posto di "Nessun elemento elaborato";
  - testi d'esito uniformi nell'area admin.

### Accessibilità e interfaccia
- **Icone da un solo kit**: tutte le icone vengono da [Lucide](https://lucide.dev) (`lucide-react`, licenza ISC), al posto degli SVG del template, delle emoji (allegati, lucchetto, collegamenti, cartelle) e dei caratteri usati come icone (frecce di ordinamento e di ritorno, ×, barra dell'editor). Restano immagini solo le bandiere delle lingue; un test impedisce il ritorno delle emoji.
- **Titoli della scheda**: per tutte le pagine dell'area admin, per le pagine di dettaglio e accesso agenti, per la 404 e per il ticket del portale (con il numero, solo se visibile).
- **Etichette dei campi**: collegate con `htmlFor`, con suggerimento ed errore in `aria-describedby` e `aria-invalid`. Gruppi di radio e checkbox con `fieldset`/`legend`; editor, firma, ricerca e titolo della nota con un nome accessibile.
- **Annunci e intestazioni**: banner con `role=alert`/`status`; `h1` nelle pagine; `aria-current`/`aria-expanded` nella navigazione.
- **Componenti interattivi**: schede del composer con `role=tab`; menu mobile del portale chiudibile con Esc.
- **Editor**: il pulsante "Collegamento" usa un riquadro della UI invece di `window.prompt`.
- **Azioni di massa**: quelle di task, utenti, organizzazioni e area admin sono inattive senza selezione. Nell'admin il conteggio è visibile e la conferma usa un dialog della UI invece di `alert()`/`confirm()`.
- **Liste su mobile**: utenti, organizzazioni e task diventano card; nelle card dei ticket i campi vuoti mostrano "—".
- **Tema scuro**: checkbox, radio e controlli nativi scuri (`color-scheme`); pulsanti disabilitati leggibili.
- **Layout**:
  - il campo portato in vista non finisce sotto l'header fisso;
  - testata del ticket stabile;
  - avvisi degli avvisi automatici (Ticket/Task) raggruppati per avviso;
  - pagina "Password dimenticata" centrata.
- **Rimandi al pannello classico** dove la funzione è solo lì: KB e risposte predefinite, configurazione dei campi dei Moduli, riordino delle liste, Plugin, lista di sistema.

### Collegamento a un osTicket in produzione (modalità attach)
Obiettivo: TailTicket non deve mai rompere un osTicket esistente.

- **Gate unico delle scritture** a livello di driver: ogni query che modifica dati passa da un solo controllo, comprese area admin, login, lock, upload, syslog e tema.
  - Tre modalità con `TAILTICKET_MODE`: `readonly`, `operational` (area admin in sola lettura) e `full`.
  - Senza la variabile vale `full`, ma si scende comunque in sola lettura se lo schema non è verificato o se un controllo critico fallisce (prefisso, SECRET_SALT, fuso).
  - In sola lettura il login funziona senza scrivere; le operazioni rispondono `read_only` e l'interfaccia mostra un banner e nasconde o disattiva le azioni.
- **Doctor** (`./tailticket doctor`, `/api/doctor` protetto da token, sezione nella pagina di sistema). Controlla:
  - schema, prefisso e fuso;
  - SECRET_SALT, sui Message-ID ricevuti e sulle credenziali cifrate dal PHP;
  - privilegi dell'utente DB (niente DDL) e invio email: verifica SMTP senza inviare; blocca se non c'è un relay;
  - allegati su filesystem, plugin e backend LDAP (avvisi), autocron;
  - fonte dei dati di connessione.
- **osTicket 1.17 supportato** (lettura e scrittura): l'harness differenziale passa per intero (351/351) sul codice e sullo schema di osTicket 1.17.8. Il doctor e le informazioni di sistema riconoscono le release dalla firma dello schema (1.10–1.18) e danno indicazioni: 1.18 e 1.17 supporto completo; 1.16 e precedenti sola lettura, da aggiornare; firma sconosciuta (1.19, 2.x, upgrade a metà) sola lettura finché non verificata. Matrice in [docs/compatibility.md](docs/compatibility.md#versioni-di-osticket).
- **`/api/health`** pubblico, usato anche dall'healthcheck Docker.
- **Registro delle scritture** (`TAILTICKET_JOURNAL_DIR`): tabelle e verbi per operazione, mai valori.
- **Annullamento delle modifiche admin**: ogni salvataggio dell'area admin (form, azioni di massa, eliminazioni, tema) registra le righe prima e dopo. Il gate cattura le righe sulla stessa transazione, con valori esatti: datetime come stringhe, date zero, NULL, binari, DECIMAL e BIGINT.
  - "Annulla modifica" nel banner di conferma, pagina *Pannello › Modifiche recenti* (stato: annullabile, annullata, non annullabile, in conflitto) e `./tailticket undo [--list | <id> | last] [--yes] [--force]`.
  - Ripristino in una sola transazione, a sua volta annullabile; rifiutato se le righe sono cambiate dopo (anche dal pannello classico), `--force` solo dal CLI. Ammesso con `TAILTICKET_MODE=full` e schema verificato anche se il doctor ha bloccato le scritture.
  - Non annullabili, con il motivo: operazioni oltre 5000 righe (es. eliminare un reparto con molti ticket) e scritture non registrabili. Le scritture SQL scritte a mano dell'area admin sono passate al query builder, tranne il clone di un set di template: resta un `INSERT … SELECT` come nel PHP, perché l'ordine degli id lo decide il server, e quindi non è annullabile.
  - Changeset in `TAILTICKET_JOURNAL_DIR/changes/` (file `600`, 30 giorni, al massimo 200), mai esposti via HTTP (SECURITY.md).
- **Configurazione da una sola fonte**:
  - con `ost-config.php` montato, DB, prefisso e SECRET_SALT vengono dal file e un valore diverso blocca l'avvio;
  - host, porta, utente e password possono differire, per un utente MySQL dedicato con soli privilegi DML.
- **Allegati su filesystem** (plugin storage-fs): letti da un mount in sola lettura (`OST_ATTACHMENTS_DIR`). Le email non partono più con allegati vuoti e i file su disco non diventano orfani.
- **I form non riscrivono più valori del PHP che non conoscono**, che ora sono mostrati e preservati:
  - storage degli allegati, backend LDAP degli agenti, credenziali OAuth2;
  - lingue secondarie, avatar e policy dei plugin, 2FA di un plugin.
- **Deploy**:
  - `init --attach --config ost-config.php [--attachments …]`;
  - `up`/`update` con avvio protetto: parte in sola lettura, esegue il doctor e scrive solo senza blocchi;
  - `mode` per passare in scrittura, solo con doctor verde, backup recente e conferma;
  - `readonly` come interruttore d'emergenza;
  - `backup` del DB di produzione in sola lettura;
  - `rehearse`: prova generale su una copia del DB, con la posta catturata da Mailpit.

### Deploy
- L'admin creato da `./tailticket up` deve cambiare la password al primo accesso, sia in TailTicket sia nel pannello classico. La password iniziale sta in chiaro in `.env` e viene stampata a schermo; prima il cambio non veniva imposto.
- Il link con token delle email agli agenti (`/classic/scp/pwreset.php?token=…`, benvenuto e reset password) apre la pagina di TailTicket. Il modulo "password dimenticata" del pannello classico resta invariato.

## [1.0.0] — 2026-10-10

Prima release stabile di TailTicket: nuova interfaccia per osTicket 1.18.4 sullo stesso database, senza DDL, con il pannello PHP classico che continua a funzionare accanto.

### Aggiunto
- **Fork strutturato**:
  - codice osTicket in `legacy/` (storia git preservata);
  - nuova app in `apps/web/`;
  - stack di deploy in `deploy/`;
  - documentazione in `docs/`.
- **Brand TailTicket**: nome, logo, icone, colore primario indaco, tagline; i loghi caricati in osTicket restano utilizzabili.
- **Deploy in un comando** (`deploy/tailticket up`): MariaDB, osTicket classico con cron, TailTicket, Caddy con HTTPS automatico. In più: modalità "attach" verso un osTicket esistente, backup/restore, aggiornamenti.
- **Protezione dello schema**: TailTicket scrive solo su schemi osTicket verificati e passa in sola lettura sugli altri. Un test in CI segnala gli aggiornamenti upstream che cambiano lo schema.
- **Documentazione del progetto**: filosofia, scope, compatibilità, architettura, sviluppo, aggiornamenti da upstream, roadmap.
- **Board Kanban** dei ticket: colonne per stato, priorità, reparto, agente o team, swimlane, filtri rapidi, ricerca, drag & drop con le stesse regole del cambio stato del PHP.
- **Statistiche e dashboard**: grafico degli eventi per periodo, schede per reparto/argomento/agente, export CSV, filtri per agente e periodo.
- **Knowledge base e risposte predefinite** per agenti e portale, con le categorie e gli allegati di osTicket.
- **Permessi visibili**: profilo di agenti, utenti e organizzazioni con stato dell'account, ticket collegati e permessi effettivi per reparto.
- **Pagina di presentazione** (`docs/index.html`, GitHub Pages).

### Modificato
- **Refactoring sulle best practice** (YAGNI, SSOT, SRP):
  - codice, stili e dipendenze inutilizzati rimossi, con knip in CI;
  - una sola fonte per ogni regola: semantica PHP dei valori (`src/server/php/values.ts`), motore dei form dinamici e validatori (`domain/forms/`), sequenze, avvisi agli agenti, bozze, costanti di osTicket (`src/lib/osticket/`), helper UI e delle server action;
  - moduli grandi divisi per responsabilità, nessun componente oltre 300 righe; le funzioni 1:1 col PHP restano intere per il confronto con l'originale.
- Il doc 17 dei contratti di scrittura si genera da `apps/web/docs/contract/*.md` e la CI verifica che sia allineato.

### Corretto
- **Fedeltà al PHP**, ognuna con uno scenario differenziale o test con valori calcolati dal PHP 8.3:
  - validatori (`isEmail` come Mail_RFC822 + `is_email`, `isIp`, `isPhone`, `is_numeric`), confronto debole `==`, `htmlchars`;
  - lettura dell'input dei form: risposte vuote salvate come NULL, date nel fuso dell'utente, liste in JSON, campi assenti con la risposta attuale, validatori completi lato agente;
  - task: riapertura del ticket con lo stato di riapertura corretto, numeri casuali con `crypto.randomInt`, creazione e modifica bloccate da qualsiasi campo non valido;
  - scadenza stimata con orari lavorativi floating nel fuso dell'agente, date dell'indice di ricerca, evento `edited` completo, doppia sostituzione delle variabili in `note.alert`;
  - import CSV degli utenti con un parser equivalente a `php_fgetcsv`.
- I criteri testuali delle code (ticket di utente/organizzazione), il conteggio esatto dei risultati e la selezione degli stati abilitati.

### Sicurezza
- IP del client letto da `X-Real-IP` impostato dal proxy: `X-Forwarded-For` era falsificabile e permetteva di aggirare il blocco dei tentativi falliti.
- Logout con revoca della sessione e durata massima di 12 ore; cambio password obbligatorio imposto su ogni pagina; redirect dopo il login solo verso percorsi interni; `APP_SESSION_SECRET` di esempio o debole rifiutato all'avvio.
- Filtro CSS delle voci del thread a prova di maiuscole, spazi, commenti ed escape (overlay); permessi più stretti del PHP su trasferimento di massa dei task, riapertura di massa, help topic privati e scadenza dei token di reset (annotati nel doc 17 §3).
- Limiti al corpo delle richieste di upload, stato in memoria con scadenza e tetto, deploy con immagini a versione fissa.
- Stato di sicurezza in memoria condiviso tra i bundle del server (revoca della sessione valida anche sulle route `/api`); titoli delle pagine senza dati per chi non ha accesso; id non validi → 404.

### Accessibilità e interfaccia
- Pagine di errore localizzate; errori delle server action gestiti con messaggio e "Riprova" senza perdere i moduli.
- Menu a tendina dentro lo schermo su mobile e navigabili da tastiera (Esc, frecce, ruoli ARIA); modali con focus trap.
- Selettore di lingua anche nel portale; il cambio lingua conserva l'URL; schede della lista ticket più leggibili su mobile.

## [0.1.0] — 2026-10-09

Prima versione completa della nuova interfaccia, sullo stesso database di osTicket 1.18.4:
- pannello agenti, area admin, portale clienti;
- 308 scenari differenziali PHP vs TypeScript, tutti identici;
- CI con qualità del codice e test differenziali.

Dettaglio per milestone: [apps/web/RESTART.md](apps/web/RESTART.md).
