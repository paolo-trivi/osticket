# Compatibilità con osTicket

La promessa di TailTicket è semplice: **un database osTicket resta un database osTicket**. Questo documento spiega come la manteniamo e come la verifichiamo.

## La promessa

1. **Nessuna modifica allo schema.** TailTicket non esegue DDL: niente tabelle, colonne, indici o migrazioni. La sua configurazione sta in righe della tabella `config` con namespace `nextui.*`, che il PHP ignora.
2. **Stesse righe del PHP.** Ogni scrittura produce esattamente le righe che produrrebbe osTicket, effetti collaterali compresi:
   - `thread_event`, `_search`, `*__cdata`, `form_entry_values`;
   - `attachment`/`file`/`file_chunk`, `syslog`, `draft`, `lock`, `sequence`;
   - `updated = NOW()` solo quando il PHP marca il record come modificato.
3. **Stesse email.** Template, variabili `%{…}`, destinatari, header e Message-ID firmati con `SECRET_SALT`, così il threading delle risposte via email continua a funzionare.
4. **Coesistenza.** Il pannello classico e TailTicket possono lavorare insieme sugli stessi dati in qualsiasi momento.

Le differenze volute riguardano i **difetti di sicurezza o permessi** di osTicket, che TailTicket non replica (applica la regola più stretta), e pochi difetti funzionali evidenti che impedirebbero di lavorare: per esempio un campo disabilitato che blocca per sempre la chiusura, o una ricerca che perde risultati. Ogni differenza ha un test e un perché, ed è elencata per area nel doc 17 §3 e nel doc 14 della knowledge base.

## Come lo verifichiamo: i test differenziali

L'harness differenziale (`apps/web/test/diff/`) funziona così:
1. clona il DB di sviluppo in uno snapshot;
2. esegue **la stessa operazione** due volte su due copie:
   - una con il **codice PHP originale** (`legacy/`, tramite `test/diff/php/runner.php`);
   - una con il **servizio TypeScript** di TailTicket;
3. confronta **tutte le tabelle**, con i datetime recenti normalizzati;
4. confronta **le email** ricevute da un Mailpit.

Lo scenario passa solo se il DB e le email sono identici. Oggi sono **351 scenari** su 33 file, e girano in CI a ogni push:
- azioni sul ticket, modifica, creazione;
- task, utenti, organizzazioni, profilo;
- portale clienti;
- impostazioni e oggetti admin.

Il contratto di scrittura (le righe che ogni operazione scrive) è documentato nel [doc 17](reverse-engineering/17-contratto-scrittura.md), generato dai file `apps/web/docs/contract/*.md`.

## Versioni di osTicket supportate

| osTicket | Firma di schema (`core.schema_signature`) | Stato |
|---|---|---|
| 1.18.x (verificato su 1.18.4) | `5fb92bef17f3b603659e024c01cc7a59` | ✅ supportato |

osTicket registra in `config` (namespace `core`, chiave `schema_signature`) la firma dell'ultima patch di schema applicata dall'upgrader. TailTicket la controlla prima di ogni scrittura (`apps/web/src/server/system/schema-compat.ts`):
- **firma verificata** → funzionamento normale;
- **firma sconosciuta**, per esempio dopo un upgrade di osTicket a una versione non ancora verificata → **sola lettura**: la consultazione funziona, le scritture sono rifiutate con un messaggio chiaro;
- per forzare le scritture a proprio rischio: `TAILTICKET_ALLOW_UNVERIFIED_SCHEMA=1`, sconsigliato in produzione.

Un test unitario confronta la firma in `legacy/include/upgrader/streams/core.sig` con quelle verificate. Se un aggiornamento da osTicket upstream cambia lo schema, **la CI fallisce** finché la nuova versione non è verificata. La procedura è in [upstream-sync.md](upstream-sync.md).

## Cosa resta al PHP

Per scelta, TailTicket non duplica i processi batch:
- cron (`api/cron.php`): fetch email, SLA e overdue, pulizie;
- pipe email e API REST;
- installer e upgrader;
- plugin PHP.

Lo stack di deploy li esegue con il codice osTicket in `legacy/`.

## Cosa significa per chi ha già osTicket

- Si può puntare TailTicket a un DB osTicket 1.18 in produzione senza alcuna migrazione ([deploy/README.md](../deploy/README.md), modalità "attach").
- Si può spegnere TailTicket in qualsiasi momento: i dati restano un normale DB osTicket.
- Gli aggiornamenti di osTicket si applicano come sempre (`php manage.php upgrade`). TailTicket li segue quando la nuova firma di schema è verificata.
