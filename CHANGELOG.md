# Changelog

Formato ispirato a [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Versioni secondo [SemVer](https://semver.org/lang/it/).

## [Non rilasciato]

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
