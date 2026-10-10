# Contratto di scrittura — area amministrazione: impostazioni, reparti, help topic, SLA, orari, agenti, team, ruoli (M5 parte A, area "admin")

Verificato con i test differenziali (righe DB ed email identiche al PHP; operazioni PHP in `test/diff/php/ops/admin.php`):

| File | Scenari |
|---|---|
| `test/diff/admin-settings.diff.test.ts` | 8 (sistema: modifica + chiavi mancanti + salvataggio identico; errori titolo/ACL/backend; ticket con autorisposte, avvisi e ordine code; errori formato/destinatari e validazione tardiva; task; agenti e utenti con errori; KB; azienda: form "C", pagine, loghi; errori) |
| `test/diff/admin-departments.diff.test.ts` | 7 (modifica con accessi estesi/ruolo membri primari; rimozione accessi; creazione sotto-reparti; errori; massa; eliminazione con spostamenti; reparto usato da un filtro) |
| `test/diff/admin-objects.diff.test.ts` | 10 (help topic: modifica con form/ordinamento, creazione, errori, massa + ordinamento manuale; SLA: modifica/creazione/errori, massa ed eliminazione; team: modifica/creazione/errori, massa ed eliminazione; ruoli: modifica/creazione/errori, massa ed eliminazione) |
| `test/diff/admin-agents.diff.test.ts` | 5 (modifica completa; creazione con email di benvenuto e con password; errori e "ultimo amministratore"; password impostata e email di reset con syslog; massa: abilita/disabilita, permessi, reparto con eavesdrop, eliminazione) |
| `test/diff/admin-schedules.diff.test.ts` | 4 (nuovo orario e clonazione; modifica con festività e ordine voci; voci annuali/settimanali/mensili/una tantum, modifica e conflitti; eliminazione voci e orari) |

```
OST_DIFF_TAG=admin MAILPIT_SMTP_PORT=1031 MAILPIT_HTTP_PORT=8031 \
  npx vitest run -c vitest.diff.config.mts test/diff/admin-*.diff.test.ts
```

Unit test: `test/unit/admin-php.test.ts` (FormData → `$_POST`, semantica PHP, JSON dei permessi).
I test degli agenti disattivano `verify_email_addrs` (nessun DNS). Token di reset normalizzati, password verificate con
`comparePassword`.

## File
| Livello | File | Contenuto |
|---|---|---|
| Server | `src/server/php/values.ts` | fonte unica della semantica PHP 8 sui `$vars` del POST (da usare in tutto `src/server`, niente copie locali): `isset`, `isArray`, `truthy`, `str`, `isNumeric`, `intval`, `list`, `at`, `inArray`, `phpLooseEquals` (`==`), `htmlchars`/`htmlcharsVars` (Format::htmlchars con sanitize opzionale); test `test/unit/php-values.test.ts` (casi verificati con PHP 8.3) |
| Dominio | `src/server/domain/admin/orm.ts` | `OrmRow`: dirty tracking di VerySimpleModel (confronto debole, INSERT dei soli campi impostati, `updated = NOW()` se modificato) |
| Dominio | `src/server/domain/admin/config-write.ts` | `ConfigWriter` = Config::update/updateAll |
| Dominio | `src/server/domain/admin/validator.ts` | Validator::process (int, string, email, cs-url, cs-domain, ipaddr), Validator::is_username (`usernameError`) |
| Dominio | `src/server/domain/admin/settings.ts` | `updateSettings` (OsticketConfig::updateSettings e update*Settings), `settingsValues`, `installedLanguages` |
| Dominio | `src/server/domain/admin/company.ts` | form azienda (tipo C): `validateCompanyForm`, `saveCompanyForm`, `companyValues` |
| Dominio | `src/server/domain/admin/dept.ts` | `saveDept`, `deleteDept`, `massDept`, `deptFullPath` |
| Dominio | `src/server/domain/admin/topic.ts` | `saveTopic`, `deleteTopic`, `massTopics`, `helpTopicsSnapshot`, `sortByName` |
| Dominio | `src/server/domain/admin/sla.ts` | `saveSla`, `deleteSla`, `massSla` |
| Dominio | `src/server/domain/admin/schedule.ts` | `addSchedule`, `updateSchedule`, `deleteSchedules`, `saveScheduleEntry`, `deleteScheduleEntries`, `processEntryForm`, `effectiveTimezone` |
| Dominio | `src/server/domain/admin/staff-admin.ts` | `saveStaff`, `setAgentPassword`, `sendAgentResetEmail`, `deleteStaff`, `massStaff`, `AGENT_PERMISSIONS` |
| Dominio | `src/server/domain/admin/team.ts` | `saveTeam`, `deleteTeam`, `massTeams` |
| Dominio | `src/server/domain/admin/role.ts` | `saveRole`, `massRoles`, `roleInUse`, `ALL_PERMISSIONS`, `rebuildPermissions` |
| Dominio | `src/server/domain/admin/filters.ts` | `filterActionsReferencing` (vedi "Filtri") |
| Dominio | `src/server/domain/admin/{common,lookups,dashboard,form-data}.ts` | esiti, elenchi per i form, sintesi della home, `parsePhpForm` |
| Server action | `admin/{departments,topics,sla,schedules,agents,teams,roles}/actions.ts`, `admin/settings/_shared/actions.ts`, `admin/_shared/server.ts` | `requireAdminAction` (solo `isadmin`), transazione, email dopo il commit |
| UI | `admin/page.tsx`, `admin/settings/{company,system,tickets,tasks,agents,users,kb}`, `admin/{departments,topics,sla,schedules,agents,teams,roles}/**` | pagine con `requireAdmin` |
| UI | `src/components/admin/{AdminForm,AccessEditor,AdminList,MassBar,AdminNotice}.tsx`, `src/lib/admin/form-schema.ts` | form a schema, liste con azioni di massa |
| Testi | `src/messages/admin/{it,en}.json` | `admUi`, `admSettings`, `admDepts`, `admTopics`, `admSla`, `admSchedules`, `admAgents`, `admTeams`, `admRoles`, `admHome` |

## Convenzioni comuni
- Le funzioni di dominio ricevono le stesse `$vars` del POST di scp/*.php (`PhpVars`: stringhe, liste `x[]`, mappe `x[k]`);
  la UI invia FormData con gli stessi nomi e `parsePhpForm` le ricostruisce.
- Modelli (department, help_topic, sla, team, role, staff, schedule, schedule_entry): un campo è modificato solo se cambia
  con confronto debole PHP (`OrmRow.set`), l'UPDATE contiene solo quei campi più `updated = NOW()`; le INSERT contengono solo
  i campi impostati (un valore "uguale a NULL" come `0`/`''` non è impostato e prende il default della colonna).
- `config` (Config::update): UPDATE solo se il valore cambia (confronto debole) con `updated = NOW()`; INSERT se la chiave
  manca (valore `''` se "uguale a NULL"); booleani scritti come `1`/`0`.
- Nessuno di questi oggetti è indicizzato in `_search` (MysqlSearchBackend indicizza solo ticket, voci, utenti, org e FAQ) e
  nessuna scrittura genera `thread_event`; i Signal `object.created/edited` non hanno ascoltatori nel core.
- Azioni di massa con `UPDATE` diretto (abilita/disabilita SLA, team, ruoli, agenti): solo `flags`/`isactive`, senza `updated`.

## Impostazioni (scp/settings.php → OsticketConfig::updateSettings)
Namespace `core`. Pagine: `system`, `tickets` (con autorisposte, avvisi e `qsort[queue_id]`), `tasks`, `agents`, `users`,
`kb`, `pages` (= "Azienda"). Chiavi e valori come `update*Settings`; in particolare:
- sistema: `$vars` passano da `Format::htmlchars($vars, true)` (sanitize + htmlspecialchars senza doppia codifica);
  ACL: con backend diverso da 0/2 l'IP del client deve essere nell'elenco; `default_storage_bk` aggiornato prima degli altri;
  lingue secondarie filtrate su quelle installate (`include/i18n` dell'installazione PHP); `force_https` = `on`/`''`;
  `acl_backend` = `Format::sanitize((int))` o `0`.
- ticket: autorisposte e avvisi sono salvati **prima** della validazione dei campi principali (se poi fallisce restano
  salvati: stranezza replicata); ordine delle code (`queue.sort`, `updated = NOW()` se cambia) tra le code con FLAG_QUEUE.
- azienda: form dinamico tipo `C` (entry con `object_type 'C'`): validazione dei campi obbligatori per l'agente, poi
  `form_entry_values` aggiornati solo se cambiano (nessun `form_entry.updated`, nessun `*__cdata`); `client_logo_id`,
  `staff_logo_id`, `staff_backdrop_id` = id scelto o `false` (→ `0`/`''`).
- Errori come codici (`required`, `invalid`, `hash`, `recipients`, `lockout`, `ip_required`, `inactive`…).

## Reparti (Dept)
- `department`: tutti i campi del form; `flags` ricostruiti da zero (quindi sempre "modificati": ogni salvataggio aggiorna
  `updated`); `path` = percorso degli antenati, per un reparto nuovo prima `//` (o `<padre>/`) e poi un secondo UPDATE con l'id.
- Accessi: `staff_dept_access` (nuovo: `staff_id`, `role_id`, `dept_id`, `flags` solo se 1 — con avvisi disattivati la riga
  nuova prende il default 1 della colonna: stranezza del PHP replicata), ruolo/avvisi aggiornati, accessi non più elencati
  eliminati; ruolo dei membri primari salvato in `staff.role_id` (+ `staff.updated`).
- Eliminazione: non il predefinito né con membri; ticket, task e agenti → reparto predefinito; help topic ed email → 0;
  accessi estesi eliminati. Massa: enable/disable/archive (flag + `updated`); `make_public`/`make_private` del PHP usano la
  colonna inesistente `dept_id` e falliscono sempre (non offerte nella UI).

## Help topic (Topic)
- `help_topic` come Topic::update (assegnazione `s<id>`/`t<id>`, numerazione personalizzata con FLAG_CUSTOM_NUMBERS,
  stato con FLAG_ACTIVE/ARCHIVED, `noautoresp`, note sanificate); nuovo sotto-topic: `sort = sort del padre + 1`.
- Ordinamento alfabetico (`help_topic_sort_mode` = `a`): `INSERT … ON DUPLICATE KEY UPDATE sort` con l'elenco letto
  **prima** del salvataggio (cache statica di getHelpTopics): un topic nuovo o rinominato non conta nella stessa richiesta.
  Collator della lingua principale (Intl.Collator).
- `help_topic_form`: form nell'ordine inviato (`sort = indice+1`), `extra = {"disable":[id campi non spuntati]}`, rimozione
  dei form non più elencati (tranne il tipo T).
- Eliminazione: non il predefinito; figli → `topic_pid 0`, `faq_topic` eliminati, ticket → `topic_id 0`; le righe
  `help_topic_form` restano (come nel PHP). Massa: almeno un topic attivo; ordinamento manuale con `sort-<id>`
  (al primo passaggio a "manuale" la chiave nuova non è letta dal PHP nella stessa richiesta: l'ordine inviato è ignorato).
- La propagazione dello stato "disabilitato" dai padri segue la stranezza di getHelpTopics (solo dal secondo livello).

## SLA
`sla` con `$vars` passati da Format::htmlchars (nome e note salvati con le entità HTML); flags = attivo | NOALERTS |
TRANSIENT. Eliminazione: non il predefinito; reparti/topic → `sla_id 0`, ticket → SLA predefinito.

## Orari (Schedule)
- Nuovo/clonazione (ajax.schedule.php): INSERT con `created/updated`, poi UPDATE di `flags` (tipo) e `updated`; clonazione
  delle voci (`created/updated = NOW()`).
- Modifica: nome, fuso (`NULL` se vuoto), descrizione sanificata; `config schedule.<id>` → `configuration`
  `{"holidays":["4"]}` (id come stringhe del POST); `schedule_entry.sort` da `sort-<id>`.
- Voci (ScheduleEntryForm::process): la data del datepicker è letta come mezzanotte UTC e convertita nel fuso dell'agente
  (o di sistema): `starts_on` è il giorno in quel fuso (nei fusi a ovest di UTC il giorno prima, come il PHP), `stops_on` è
  data e ora in quel fuso; tutto il giorno = 00:00:00–23:59:59; `ends_at` con secondi 59 se i minuti non sono 00;
  `day/week/month` per settimanale/mensile/annuale; unicità come Schedule::isEntryUnique. In modifica si impostano solo
  le chiavi calcolate (le vecchie `day/week/month` restano: stranezza replicata).
- Eliminazione: orario e voci (la config `schedule.<id>` resta).

## Agenti (Staff)
- `staff` come Staff::update: `isadmin`, `isactive` (= non bloccato), **`isvisible = 0` a ogni salvataggio** (il form PHP
  non ha il campo: stranezza replicata; su un agente nuovo 0 non è impostato e resta il default 1), `onvacation`,
  `assigned_only`, dati anagrafici (telefono con Format::phone), note, `permissions` (RolePermission JSON o `''` se nessuno),
  `extra.def_assn_role`, password (`passwd`, `change_passwd`, `passwdreset = NOW()`, token `pwreset` dell'agente eliminati).
- Reparto primario (setDepartmentId: rimuove l'eventuale accesso esteso a quel reparto), accessi estesi (`staff_dept_access`
  salvati uno per uno), team (`team_member`).
- Controllo "unico amministratore attivo": confronta con l'id dell'ultima ricerca per username/email (`$uid`), quindi se
  cambia anche l'email il controllo non scatta (stranezza replicata).
- Creazione: senza password e con backend locale → email di benvenuto (`registration-staff`, token in `config pwreset`,
  nessun syslog); con password: PasswordResetForm (obbligatoria, politica, conferma).
- ajax.staff.php setPassword: email `pwreset-staff` (syslog Warning "Agent Password Reset" con `Requested-User-Id` vuoto)
  oppure nuova password (+ `change_passwd` facoltativo).
- Eliminazione (non se stessi): ticket → `staff_id 0`, `thread_entry.staff_id = 0` con `poster = "Nome Cognome"`,
  team e accessi eliminati; i task assegnati restano (come nel PHP).
- Massa: attiva/blocca (`isactive`, senza `updated`), permessi (senza permessi il PHP non salva), reparto (con eavesdrop:
  accesso esteso al vecchio reparto con avvisi), elimina.

## Team e ruoli
- `team`: flags = abilitato | NOALERTS, capo team azzerato se rimosso (`remove[]`), membri `team_member` (avvisi = flag 1).
  Eliminazione: membri eliminati, ticket → `team_id 0`.
- `role`: nome e note sanificati, `permissions` JSON: chiavi esistenti nel loro ordine, nuove in coda nell'ordine di
  RolePermission::allPermissions (gruppo, titolo); almeno un permesso. Eliminazione solo se nessun agente o accesso usa il ruolo.

## Filtri (differenza voluta)
`Signal object.deleted → Filter::disableFilters` va in errore fatale nel PHP quando un'azione di filtro fa riferimento
all'oggetto eliminato (reparto, topic, agente, team, SLA): la riga principale viene cancellata ma ticket/task/accessi
non vengono aggiornati (dati orfani). In TS l'eliminazione viene **rifiutata senza scritture** (errore `filter`).
Il riallineamento dei flag dei filtri al cambio di stato (FilterAction::setFilterFlags) nel PHP non scrive mai nulla
(Filter::update fallisce per le regole mancanti): niente da replicare.

## Permessi (differenze di sicurezza)
- ajax.schedule.php (nuovo orario, voci) richiede solo un agente autenticato: qui tutte le scritture admin richiedono `isadmin`
  (pagine con `requireAdmin`, server action con `requireAdminAction`).

## Non gestito (resta al PHP)
- Caricamento ed eliminazione di loghi/sfondi (`AttachmentFile::uploadLogo/uploadBackdrop/delete`): la pagina Azienda
  permette solo di scegliere tra i file già caricati.
- Traduzioni dei nomi (CustomDataTranslation) di reparti, topic, SLA, team, ruoli e voci degli orari.
- Esportazione CSV degli agenti/membri del reparto; importazione agenti; "ferie di massa" (non esiste nel PHP).
