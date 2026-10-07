# Reverse engineering di osTicket — Indice

**Baseline analizzata**: branch `develop` (= serie 1.18.x), versione **v1.18.4**, commit `8d38b06`. I branch `1.17.x` e precedenti sono legacy; vedi doc 01 §1 per il confronto tra branch.

**Obiettivo**: descrivere osTicket con un livello di dettaglio sufficiente perché un LLM (o un team) possa riscriverlo da zero, preservandone il comportamento funzionale, e migrare i dati esistenti.

## Documenti

| # | Documento | Contenuto |
|---|---|---|
| 01 | [Architettura](01-architettura.md) | Branch, natura dell'app (PHP page-controller, nessuna SP/trigger/view), directory, `ost-config.php`, bootstrap, router, cron, componenti trasversali, dipendenze, gestione del tempo, glossario |
| 02 | [Database](02-database.md) | Tutte le tabelle colonna per colonna, relazioni logiche (nessuna FK fisica), flag bitmask, oggetti polimorfici, seed YAML |
| 03 | [Framework, ORM, eventi, plugin](03-framework-orm-eventi-plugin.md) | ORM stile Django (`VerySimpleModel`, `QuerySet`, `Q`), Signal bus ed elenco eventi, plugin e istanze, registri estendibili, cancellazioni a cascata applicative |
| 04 | [Ticket](04-ticket.md) | Pipeline di creazione (ordine esatto), filtri, visibilità/permessi, stati, assegnazione/claim/transfer/referral, post nel thread, SLA e orari lavorativi, overdue, lock, matrice notifiche, collaboratori, merge/link, modifica, cancellazione |
| 05 | [Thread, email, file](05-thread-email-file.md) | Thread ed entry (M/R/N, versioni), eventi, email in ingresso (fetch, parsing, threading, Message-ID firmati), email in uscita, template, motore variabili `%{}`, file chunked e URL firmati, bozze |
| 06 | [Form dinamici e liste](06-form-dinamici-liste.md) | Modello EAV, tipi di campo, flag di visibilità, tabelle `*__cdata`, liste custom |
| 07 | [Task, KB, canned, pagine](07-task-kb-canned.md) | Task, Knowledge Base (FAQ/categorie), risposte predefinite, pagine/contenuti, quick notes |
| 08 | [Code, ricerca, export, statistiche](08-code-ricerca-export-statistiche.md) | Code personalizzabili (criteri, colonne, ordinamenti), ricerca full-text, export CSV, dashboard/statistiche |
| 09 | [Utenti, agenti, permessi, autenticazione](09-utenti-agenti-permessi-autenticazione.md) | User/Organization, Staff, reparti/team/ruoli, permessi di ruolo e globali, backend di autenticazione, lockout, reset, 2FA, sessioni, CSRF, ACL IP |
| 10 | [API e rotte AJAX](10-api-e-rotte-ajax.md) | API REST (`/api/tickets.*`, cron), pipe email, tutte le rotte AJAX staff/client con permessi |
| 11 | [Frontend e schermate](11-frontend-schermate.md) | Portale cliente, pannello agenti, admin: pagine, componenti, JS |
| 12 | [i18n, installer, upgrade, CLI](12-i18n-installer-upgrade-cli.md) | Traduzioni UI e contenuti, installazione, upgrader a signature, `manage.php`, test |
| 13 | [Impostazioni (reference)](13-impostazioni-config-reference.md) | Tutte le chiavi di configurazione con default ed effetto, regole di validazione degli oggetti admin |
| 14 | [Sicurezza](14-sicurezza.md) | Controlli presenti, debolezze, **bug noti da non replicare**, patch di sicurezza recenti come test di regressione |
| 15 | [Guida alla riscrittura](15-guida-riscrittura.md) | Mappatura su Laravel + PostgreSQL: moduli, servizi, job, API, frontend, ETL di migrazione, checklist di test, milestone |
| 16 | [Schema PostgreSQL proposto](16-schema-postgresql-proposto.sql) | DDL PostgreSQL fedele allo schema MySQL con 97 FK reali (validato su PostgreSQL 16: 67 tabelle) |

## Come usare questa documentazione
1. **Per capire il prodotto**: 01 → 02 → 04 → 05 → 09.
2. **Per riscriverlo**: leggere 15 (piano), poi implementare modulo per modulo usando i documenti di dettaglio indicati in ogni sezione; usare 16 come schema di partenza e la checklist di 15 §9 come test di accettazione.
3. **Per migrare i dati**: 02 (schema sorgente), 15 §8 (ETL), 16 (schema destinazione), 05 §2.6 (compatibilità Message-ID), 14 (crittografia credenziali).

## Fatti chiave in sintesi
- **Nessuna stored procedure, trigger, view o foreign key**: tutta la logica e l'integrità referenziale sono nel PHP.
- Datetime salvati nel fuso del server MySQL; PHP lavora in UTC (doc 01 §12) — attenzione nell'ETL.
- Charset `utf8` a 3 byte (emoji rimosse), `SQL_MODE=''`.
- Campi custom in EAV (`form_entry_values`) materializzati in tabelle `*__cdata`; oggetto e priorità del ticket vivono nel form, non nella tabella `ticket`.
- Threading delle email basato su Message-ID firmati con `SECRET_SALT`: va preservato per non spezzare le conversazioni dopo la migrazione.
- Diversi bug storici documentati in doc 14 §2 punto 10.

## Convenzioni
- "doc NN §x.y" = documento NN, sezione x.y.
- Nomi di tabelle senza prefisso (`ost_` nell'installazione di default).
- I percorsi dei file sorgente sono relativi alla root del repository.
