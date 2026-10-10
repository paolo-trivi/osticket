# Scope del progetto

Cosa TailTicket è, cosa non è e dove vuole arrivare.

## In una frase

TailTicket è **una nuova interfaccia completa per osTicket 1.18** (pannello agenti, area admin, portale clienti), che lavora sullo stesso database del PHP e ne riproduce fedelmente il comportamento, più un **pacchetto di deploy** che mette in piedi tutto con un comando.

## Nello scope

| Area | Cosa copre | Stato |
|---|---|---|
| Pannello agenti | code, ricerca, vista ticket, risposta/nota con allegati, assegna/claim/rilascio/trasferimento/referral, stati, modifica, collaboratori, merge/link, eliminazione, azioni di massa, export CSV, nuovo ticket, task, utenti e organizzazioni, KB e risposte predefinite, profilo, 2FA email | ✅ |
| Area amministrazione | impostazioni (azienda, sistema, ticket, task, agenti, utenti, KB, email), reparti, help topic, SLA, orari, agenti, team, ruoli; account email, template, ban list, diagnostica, filtri, form, liste, pagine, code (attivazione), chiavi API, log, plugin (attivazione), tema e brand | ✅ |
| Portale clienti | home e pagine di contenuto, KB pubblica, login/registrazione/reset, accesso ospite e link con token, i miei ticket, risposta, modifica dei campi, apertura ticket con allegati, profilo | ✅ |
| Compatibilità DB | stesse righe ed email del PHP, verificate da 351 scenari differenziali; sola lettura su schemi non verificati | ✅ |
| Deploy | Docker Compose con TailTicket, osTicket classico, cron, MariaDB, reverse proxy HTTPS; modalità "collega un osTicket esistente"; backup e aggiornamenti | ✅ |
| Brand e UX | tema configurabile, chiaro/scuro, responsive, italiano e inglese | ✅ |

## Fuori scope (per scelta)

- **Cambiare lo schema del database.** Niente tabelle, colonne o migrazioni proprie: è la condizione per restare compatibili con osTicket e con i suoi aggiornamenti.
- **Riscrivere i processi batch.** Cron, fetch delle email (IMAP/POP), pipe email, API REST `/api/*.php`, installer e upgrader restano al PHP, che gira accanto a TailTicket.
- **Eseguire plugin PHP.** I plugin di osTicket continuano a funzionare nel PHP. TailTicket ne gestisce solo l'attivazione.
- **Diventare un prodotto diverso.** TailTicket non introduce funzioni che il DB di osTicket non può rappresentare. Le novità passano dall'interfaccia, non dal modello dati.

## Restano al pannello classico (per ora)

Funzioni presenti in osTicket ma non ancora in TailTicket. Si usano dal pannello classico, che resta sempre disponibile.

- OAuth2 degli account email e backend di autenticazione esterni (LDAP, OAuth).
- Caricamento di loghi e sfondi del pannello classico.
- Modifiche ai form che richiedono DDL sulle tabelle `*__cdata`. TailTicket le rifiuta in modo esplicito.
- Creazione e modifica delle code (criteri, colonne), configurazione dei singoli campi dei form, import CSV delle liste.
- Stampa PDF, "gestisci form" del ticket, "modifica e reinvia".
- Captcha del portale: con `enable_captcha` attivo, l'apertura ticket da ospite va fatta dal portale classico.
- Traduzioni dei contenuti (pagine, form) nel DB.

## Limiti tecnici noti

- **Una sola istanza di TailTicket**: codici 2FA, contatori dei tentativi falliti e sessioni revocate al logout stanno in memoria.
- **Reverse proxy e HTTPS obbligatori**: l'IP del client si legge da `X-Real-IP` impostato dal proxy (o dal valore più a destra di `X-Forwarded-For`, vedi [SECURITY.md](../SECURITY.md)) e i cookie sono `Secure`.
- **Testo alternativo delle email** (text/plain): l'impaginazione può differire da quella del PHP; HTML, header e Message-ID sono identici.
- **Testo semplice con rich text disattivato**: la chiusura dei tag sbilanciati di `html_balance` non è replicata.

## Direzione

La roadmap è in [roadmap.md](roadmap.md). In sintesi:
1. chiudere le funzioni ancora riservate al pannello classico;
2. rendere TailTicket scalabile su più istanze, con lo stato condiviso fuori dalla memoria e sempre senza DDL;
3. seguire le nuove versioni di osTicket verificandone lo schema ([upstream-sync.md](upstream-sync.md)).
