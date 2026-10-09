# Contratto di scrittura — task, utenti, organizzazioni, profilo agente, 2FA (M3 parte B, area "people")

Verificato con i test differenziali (righe DB ed email identiche al PHP; operazioni PHP in `test/diff/php/ops/people.php`):

| File | Scenari |
|---|---|
| `test/diff/tasks.diff.test.ts` | 10 (creazione, note/risposte, assegnazione, claim, trasferimento, stato, modifica, scadenza, eliminazione, massa, avvisi email) |
| `test/diff/people-directory.diff.test.ts` | 9 (utenti: creazione, modifica, organizzazione, eliminazione, import CSV, account, email di attivazione/reset; organizzazioni: creazione, campi, profilo, eliminazione, membri) |
| `test/diff/people-profile.diff.test.ts` | 7 (profilo, validazione, cambio password, reset via email + login con token, 2FA dal profilo, login con 2FA, tentativi falliti + avviso admin) |
| `test/diff/staff-login.diff.test.ts` | 3 (login, invariato) |

```
OST_DIFF_TAG=people MAILPIT_SMTP_PORT=1029 MAILPIT_HTTP_PORT=8029 \
  npx vitest run -c vitest.diff.config.mts test/diff/tasks.diff.test.ts test/diff/people*.diff.test.ts test/diff/staff-login.diff.test.ts
```

I test disattivano `verify_email_addrs` (nessun DNS nell'ambiente). Token casuali (`config.pwreset`), hash delle
password e codici 2FA vengono normalizzati prima del confronto; le password sono verificate con `comparePassword`.

## File
| Livello | File | Contenuto |
|---|---|---|
| Dominio | `src/server/domain/task/{model,vars,write,tasks}.ts` | task (scritture, avvisi, lista/visibilità) |
| Dominio | `src/server/domain/forms/answers.ts` | form dinamici U/O/A/C: entry, risposte, validazione lato agente (motore comune `forms/`: campi e flag in `fields.ts`, `*__cdata` in `cdata.ts`, equivalenti di `Validator` in `validator.ts`) |
| Dominio | `src/server/domain/directory/users.ts` | `createUser`, `updateUser`, `setUserOrganization`, `removeUserFromOrg`, `deleteUser`, `importUsers`, `reindexUser` |
| Dominio | `src/server/domain/directory/accounts.ts` | `registerAccount`, `updateAccount`, `sendUserResetEmail`, `sendUserConfirmEmail`, `massUserAction`, `checkPasswordPolicy` |
| Dominio | `src/server/domain/directory/orgs.ts` | `createOrg`, `updateOrg`, `updateOrgProfile`, `deleteOrg`, `massDeleteOrgs`, `removeOrgUsers`, `addOrgUser` |
| Dominio | `src/server/domain/directory/content-mail.ts` | email da pagine di contenuto (`Page::lookupByType` + `replaceTemplateVariables` + `Email::send`) |
| Dominio | `src/server/domain/directory/ui.ts` | campi dei form per la UI (`toDynFields`, `editFormFields`, `formSource`) |
| Dominio | `src/server/domain/staff/profile.ts` | `updateStaffProfile`, `changeStaffPassword`, `sendStaffResetEmail`, `verifyStaffResetToken`, `setup2faEmail`, `verify2faSetup`, `updateStaffConfig` |
| Auth | `src/server/auth/mfa.ts` | backend 2FA email (`prepare2faEmail`, `validateOtp`, `staff2faConfig`) |
| Auth | `src/server/auth/staff-recovery.ts` | verifica 2FA al login, reset password (richiesta, login con token), sessione dopo cambio password |
| Auth (core, additivo) | `src/server/auth/staff-auth.ts`, `session.ts` | 2FA al login, avviso admin sui tentativi falliti, campi `mfk`/`rst` della sessione |
| Server action | `agent/(panel)/{tasks,users,orgs,profile}/actions.ts`, `agent/login/recovery-actions.ts` | azioni della UI |
| UI | `src/components/people/**`, pagine `tasks`, `users`, `orgs`, `profile`, `login/verify`, `login/reset` | |
| Testi | `src/messages/people/{it,en}.json` | `peopleUi`, `peopleTasks`, `peopleDir`, `peopleProfile`, `peopleAuth` |

## Convenzioni comuni
- Le scritture passano da `runWrite` (transazione); le email partono dopo il commit (`ctx.after`), tranne login/reset
  (fuori transazione, come il PHP che invia durante la richiesta).
- Form dinamici: `form_entry` (`created/updated = NOW()`), una `form_entry_values` per campo memorizzabile
  (non `EXT_STORED`: `name`/`email` di utenti e org non hanno risposta), valore `NULL` se vuoto per il confronto debole;
  ogni risposta inserita/modificata aggiorna la colonna in `*__cdata` (`INSERT … ON DUPLICATE KEY UPDATE`, scelte →
  chiavi separate da virgola, `NULL` → `''`). In modifica cambiano solo i campi presenti nella sorgente (Widget::getValue).
- Indice `_search`: `U` = risposte (tranne `subject`) + `" "` + indirizzi email uniti da `\n`, titolo = nome;
  `O` = risposte, titolo = nome. Alla creazione la relazione `emails` del PHP contiene l'indirizzo due volte (anche
  in un `setOrganization` nella stessa richiesta): replicato.
- `user.updated = NOW()` e reindicizzazione solo se il modello è "sporco" (`User::save`); il nome assegnato conta come
  modifica anche se la normalizzazione ("Cognome, Nome" → "Nome Cognome") lo riporta uguale.
- `organization.updated` è `ON UPDATE CURRENT_TIMESTAMP`: cambia a ogni UPDATE della riga.

## Task
Vedi i commenti di `src/server/domain/task/write.ts`. Tabelle: `task` (`number` da `sequence` o casuale),
`task__cdata`, `form_entry(_values)`, `thread` (A), `thread_entry` (M con flag ORIGINAL, N, R), `thread_event`
(`created`, `assigned` con `claim`/`staff`(AgentsName)/`team`, `transferred`, `closed`, `reopened` con annullamento,
`edited`, `deleted`), nota sul ticket collegato (chiusura/riapertura, con riapertura del ticket chiuso), `_search`,
`draft` (`task.%.<id>` all'eliminazione; `task.note|response.<id>` e `task.add` dell'agente dopo la pubblicazione),
`syslog` Debug all'eliminazione. Email: `task.alert`, `task.activity.alert`, `task.assignment.alert`, `task.transfer.alert`.

## Utenti
| Operazione | Scritture |
|---|---|
| Creazione (`User::fromForm/fromVars`) | `user_email` (`user_id` 0 poi aggiornato), `user` (`org_id` = `org_id` passato o `Organization::forDomain`, `status` 0, nome normalizzato, `created/updated = NOW()`), entry del form "Contact Information" + `user__cdata`, `_search` U |
| Modifica (`User::updateInfo`, staff) | `user_email.address` se cambiato; risposte + cdata; `user` (nome, `updated`) + `_search` se sporco |
| Organizzazione (`setOrganization`) | `user.org_id`, `updated`, `_search` |
| Rimozione dall'org (`Organization::removeUser`) | `user.org_id = 0` (NULL convertito da MySQL), bit `PRIMARY_ORG_CONTACT` tolto, `updated`, `_search` |
| Eliminazione (`User::delete`) | rifiutata con ticket; `user_account`, `user_email`, `form_entry(_values)` (cdata restano), `user`, `_search` |
| Import CSV (`User::importFromPost`) | intestazione `name, email` anteposta al testo incollato; per riga creazione o `updateInfo` dell'esistente (l'`org_id` predefinito vale solo per i nuovi); tutto o niente (SAVEPOINT) |
| Registrazione account (`UserAccount::register`) | `user_account` (`user_id`, `timezone` o NULL, `backend`, `username` sanificato se diverso da `"Nome" <email>`, `passwd` bcrypt, `status` CONFIRMED [+ REQUIRE_PASSWD_RESET/FORBID_PASSWD_RESET]); con `sendemail` nessuna password, `status` 0 ed email di attivazione |
| Gestione account (`UserAccount::update`) | `timezone`, `username` (sanificato), `passwd` + CONFIRMED, bit LOCKED/REQUIRE_PASSWD_RESET/FORBID_PASSWD_RESET da flag; UPDATE solo se cambia qualcosa |
| Blocco/sblocco (massa) | `user_account.status` bit LOCKED |
| Email attivazione/reset (`sendUnlockEmail`) | `config` (`namespace` pwreset, `key` = token 48 caratteri `Misc::randCode`, `value` = `c<user_id>`, `updated`); email pagina `registration-client` / `pwreset-client` dall'email predefinita a `"Nome" <email>`, link `<helpdesk>/pwreset.php?token=…` |

## Organizzazioni
| Operazione | Scritture |
|---|---|
| Creazione (`Organization::fromForm/fromVars`) | `organization` (`name` striptags, `status` = 8 SHARE_PRIMARY_CONTACT, `created/updated = NOW()`), entry "Organization Information" + `organization__cdata`, `_search` O |
| Campi (`Organization::update`) | nome cambiato → UPDATE + `_search` **prima** delle risposte (indice con le risposte vecchie); risposte + cdata; senza `contacts` tutti i membri perdono il bit di contatto principale (`status & ~1`, senza `updated`) |
| Profilo (`updateProfile`) | come sopra, poi `status` (bit 1/2/4 da flag, 8/16 da `sharing`), `domain`, `manager` (`s<id>`/`t<id>`), `updated` se risposte salvate, `_search`; contatti indicati → `user.status`, `updated`, `_search` per i membri cambiati |
| Eliminazione (`Organization::delete`) | `organization`, `_search`, membri `org_id = 0` (senza `updated`), `form_entry(_values)` (cdata restano) |
| Rimozione membri | `removeUser` per ogni id (anche se l'utente non è membro, come il PHP) |
| Aggiunta utente | esistente → `setOrganization`; nuovo → creazione + `setOrganization` |

## Profilo agente
| Operazione | Scritture |
|---|---|
| Preferenze (`Staff::updateProfile`) | `config` `staff.<id>` (INSERT o UPDATE se cambiato, `updated`): `datetime_format`, `default_from_name`, `default_2fa`, `thread_view_order`, `default_ticket_queue_id`, `reply_redirect` (Queue/Ticket), `img_att_view` (inline/download), `editor_spacing` (double/single); poi `staff` (nome striptags, email, telefono/cellulare `Format::phone`, interno, firma sanificata, fuso, locale, lingua, righe, aggiornamento, firma predefinita, carta, ferie) con `updated` se cambia qualcosa |
| Cambio password (`changePassword` + `Staff::setPassword`) | password attuale (non con token di reset), conferma, politica (6–128 byte, diversa dall'attuale ignorando le maiuscole); `config` pwreset dell'agente eliminati, `staff.passwd` bcrypt, `change_passwd = 0`, `passwdreset = NOW()`, `updated` |
| Reset via email (`Staff::sendResetEmail`) | `syslog` Warning "Agent Password Reset" (testo sanificato), `config` pwreset (`value` = staff_id), email pagina `pwreset-staff` dall'email di avviso, link `<helpdesk>/scp/pwreset.php?token=…` |
| Login con token (`PasswordResetTokenBackend`) | `staff.change_passwd = 1` + `updated`, poi come il login (`extra.browser_lang`, `lastlogin`, `updated`), token non annullato fino al cambio password |
| 2FA dal profilo (`configure2FA`) | `config` `staff.<id>`.`2fa-email` = `{"config":{"email":…},"verified":0}`, email `email2fa-staff` con il codice; verifica → `verified = time()` |

## Login agenti
- 2FA email (`default_2fa = 2fa-email` e configurazione presente): stesse scritture del login senza 2FA più l'email
  `email2fa-staff` (codice di 6 cifre, all'email principale dell'agente) dall'email di avviso; sessione "pendente" fino al
  codice (6 minuti, 3 tentativi; poi logout con syslog "Agent logout"). Backend 2FA di plugin: `mfa_unsupported`.
- Tentativi falliti (`StaffAuthStrikeBackend`): `syslog` Warning ogni 3 tentativi; oltre `staff_max_logins` blocco per
  `staff_login_timeout`, `syslog` Warning "Excessive login attempts (<utente>)" e, con `send_login_errors`, email di solo
  testo all'amministratore (`osTicket::alertAdmin`). Testi del log sanificati (`Format::sanitize`), data `M j, Y, g:i a T` UTC.

## Differenze e bug del PHP
- **Permessi non replicati** (regola più stretta, annotata nel codice):
  - `scp/users.php do=create` non controlla `user.create`; `do=mass_process` e `confirmlink/pwreset` non controllano
    i permessi → `user.manage`/`user.delete`/`user.edit`;
  - `scp/orgs.php` (remove-users, mass delete, import) non controlla i permessi → `user.edit`, `org.delete`,
    `org.create` + `user.create`;
  - `Task::checkStaffPerm` mostra a tutti i task chiusi → accesso solo per reparto/assegnazione (già annotato);
  - `scp/tasks.php a=postreply` non controlla `task.reply` → richiesto.
- **Stranezze replicate**: email doppia nell'indice dei nuovi utenti; `UserAccount::update` non verifica `passwd2`;
  username impostato anche se uguale all'email (confronto con `"Nome" <email>`); `Organization::update` senza `contacts`
  azzera i contatti principali e reindicizza prima di salvare le risposte; `removeUser` non verifica l'appartenenza;
  `changePassword` con token non verifica davvero la finestra di validità (`&&` al posto di `||`); il 2FA invia il codice
  all'email principale e non a quella configurata; `default_2fa` impostato ma non configurato → login senza 2FA.
- **Validatori comuni** (`forms/validator.ts`, un'unica implementazione per tutte le aree): `isEmail` è il port di
  `Mail_RFC822::parseAddressList` usato da `Validator::is_email` (prima due regex diverse fra loro e dal PHP, ad es.
  su `a@b`, `Nome <a@b.com>`, `a..b@c.com`, `a@LOCALHOST`); `isPhone` non toglie lo spazio non separabile e
  `is_numeric` ammette solo gli spazi ASCII, come il PHP; `isIp` = `FILTER_VALIDATE_IP`. Coperti da
  `test/unit/forms-validator.test.ts` (esiti calcolati con PHP) e dallo scenario RFC 822 di
  `adminsys-banlist.diff.test.ts`.
- **Differenze**: stato 2FA e contatore dei tentativi in memoria del processo (non in `$_SESSION`); finestra del token di
  reset calcolata nel DB (il PHP interpreta l'ora del DB come UTC); traduzioni delle pagine di contenuto non gestite;
  eliminazione dei ticket di un utente (`deleteAllTickets`) non disponibile finché l'area ticketedit non espone
  l'eliminazione del ticket (`deleteUser` accetta `hardDeleteTicket`).
