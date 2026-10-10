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

## Versioni di osTicket

| osTicket | Firma di schema (`core.schema_signature`) | Lettura | Scrittura | Note |
|---|---|---|---|---|
| 1.18.x | `5fb92bef17f3b603659e024c01cc7a59` | sì | sì | verificato su 1.18.4 (il codice di `legacy/`); consigliata |
| 1.17.x | `83a22ba22b1a6a624fcb1da03882ac1b` | sì | sì | verificato su 1.17.8: harness differenziale completo (351/351) su codice e schema del tag |
| 1.16.x | `c37e165651dc289240fee7d244990ac1` | parziale, non verificata | no | mancano `email_account` e `plugin_instance` (arrivano con la 1.17): email e plugin non leggibili. Aggiornare osTicket |
| 1.15.x, 1.14.x | `add62892…`, `4bd47d94…` | parziale, non verificata | no | come la 1.16, più le patch di 1.15/1.16 (`thread_entry_email.email_id`, `help_topic.topic`). Aggiornare osTicket |
| 1.12 e precedenti | `00c949a6…` (1.11/1.12), `98ad7d55…` (1.10) | no | no | riconosciute solo per dirlo nel doctor |
| firma sconosciuta | — | parziale | no | release più recente (1.19, 2.x), upgrade di osTicket non completato o schema modificato: sola lettura finché la versione non è verificata |

Le firme note sono in `KNOWN_SCHEMAS` (`apps/web/src/server/system/schema-compat.ts`): il doctor e le informazioni di sistema dicono "osTicket 1.16 rilevato" invece di una firma anonima, con le indicazioni del caso. La firma è la stessa per tutte le patch di una serie (1.17.0 … 1.17.8): conviene la patch su cui TailTicket è verificato, perché le patch precedenti hanno logica PHP diversa (correzioni di sicurezza).

**1.17.8 e 1.18.4** sono state rilasciate lo stesso giorno e differiscono pochissimo:
- schema: solo `plugin.name` e `plugin_instance.name` portati a `VARCHAR(255)` (`83a22ba2-5fb92bef.patch.sql`); TailTicket non scrive quei campi;
- PHP: `MAJOR_VERSION`, la "strict mode" di OAuth2 in `EmailAccount::updateOAuth2AuthCredentials` (OAuth2 non è gestito da TailTicket, resta al PHP), il template della pagina del token OAuth2 e `manage.php`;
- dati dell'installer: identici (stesse righe in `config`, template, form, code).

Non servono quindi rami per versione nel codice TypeScript. Dalla 1.16 in giù le differenze sono strutturali (account email e plugin multi-istanza introdotti con la 1.17, ~190 file PHP cambiati tra 1.16.6 e 1.17.8): il supporto richiederebbe un porting dedicato, la strada consigliata è aggiornare osTicket.

### Verificare una nuova versione

1. Estrarre il codice del tag in una cartella temporanea (`git archive v1.x.y | tar -x -C <dir>`) e installarlo su un MariaDB isolato con `apps/web/dev/osticket-install.php`; confrontare schema e dati dell'installer con quelli della versione verificata (`information_schema.COLUMNS`, dump senza datetime).
2. Portare la fixture `apps/web/dev/fixtures/osticket-dev.sql.gz` allo schema della nuova versione (le patch `include/upgrader/streams/core/*.patch.sql`, o il loro inverso per una versione precedente) e aggiornare `core.schema_signature`.
3. Eseguire tutto l'harness con `OST_DIR`/`OST_CONFIG_PATH` sul codice del tag e `TAILTICKET_ALLOW_UNVERIFIED_SCHEMA=1` (altrimenti le scritture TypeScript vengono rifiutate): `npm run test:diff`.
4. Leggere `git diff` tra la versione verificata e la nuova sui file citati dai contratti (`apps/web/docs/contract/*.md`); allineare il TypeScript, con rami per versione solo dove il PHP cambia davvero.
5. Solo con l'harness tutto verde: `verifiedOn` in `KNOWN_SCHEMAS`, una riga in questa tabella.

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

- Si può puntare TailTicket a un DB osTicket 1.18 o 1.17 in produzione senza alcuna migrazione ([deploy/README.md](../deploy/README.md), modalità "attach"). La configurazione si legge dall'`ost-config.php` esistente, montato in sola lettura: una variabile d'ambiente in conflitto con il file blocca l'avvio.
- **Si parte in sola lettura.** In attach `TAILTICKET_MODE` vale `readonly`; `operational` (lavoro quotidiano, area admin in sola lettura) e `full` si attivano con `./tailticket mode`, solo con il doctor senza blocchi, un backup recente e una conferma esplicita.
- **Il doctor** (`./tailticket doctor`) verifica prima di ogni scrittura ciò che potrebbe rompere l'osTicket esistente: firma dello schema, prefisso delle tabelle, `SECRET_SALT`, fuso orario del DB, permessi dell'utente MySQL (niente DDL), email in uscita, allegati su disco, plugin, cron. Con un problema critico la modalità effettiva scende da sola a sola lettura.
- **Prova generale**: `./tailticket rehearse` ripete il collegamento su una copia del DB di produzione con l'osTicket di `legacy/`, con la posta in uscita catturata da Mailpit e le caselle in entrata spente.
- **Registro delle scritture**: ogni transazione confermata da TailTicket lascia una riga JSON (tabelle e verbi, senza valori) in `TAILTICKET_JOURNAL_DIR`.
- **Annullamento delle modifiche admin**: in `full` ogni salvataggio dell'area admin registra le righe prima e dopo e si può annullare dal banner, da *Modifiche recenti* o con `./tailticket undo`, salvo conflitti con modifiche successive (anche dal pannello classico) e operazioni oltre 5000 righe.
- Cron, email in entrata, API e plugin restano al PHP esistente, che continua a girare come prima.
- Si può spegnere TailTicket in qualsiasi momento (`./tailticket readonly` per l'emergenza, `./tailticket down` per fermarlo): i dati restano un normale DB osTicket.
- Gli aggiornamenti di osTicket si applicano come sempre (`php manage.php upgrade`). TailTicket li segue quando la nuova firma di schema è verificata; fino ad allora resta in sola lettura.
