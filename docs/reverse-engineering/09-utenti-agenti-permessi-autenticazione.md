# 09 — Utenti, organizzazioni, agenti, reparti, team, ruoli, permessi, autenticazione, sessioni

File: `class.user.php`, `class.client.php`, `class.organization.php`, `class.staff.php`, `class.dept.php`, `class.team.php`, `class.role.php`, `class.auth.php`, `class.usersession.php`, `class.ostsession.php`, `class.2fa.php`, `class.passwd.php`, `class.csrf.php`, `class.crypto.php`, `class.avatar.php`; controller `scp/users.php`, `scp/orgs.php`, `scp/staff.php`, `scp/departments.php`, `scp/teams.php`, `scp/roles.php`, `login.php`, `scp/login.php`, `pwreset.php`, `scp/pwreset.php`, `account.php`, `profile.php`.

## 1. Utenti finali (User)

### 1.1 Modello
- `user` (nome, org, email di default, status) + `user_email` (1..N indirizzi, ognuno **univoco globalmente**) + `user_account` (0..1, credenziali) + form "Contact Information" (tipo U: `email`, `name`, `phone`, `notes` + custom) → `user__cdata`.
- Classi runtime: `User` (modello), `EndUser` (wrapper per sessione cliente), `TicketUser` → `TicketOwner` (proprietario di un ticket) e `Collaborator`; `ClientSession` (utente loggato).
- Nome: `PersonsName` con formato `client_name_format` (`original`, `first`, `last`, `full`, `lastfirst`, `legal`, `short`, `shortformal`…).
- "Guest": utente senza account, oppure entrato via token/access link (`flagGuest()`): vede solo i ticket autorizzati.

### 1.2 Creazione (`User::fromVars($vars, $create, $update)`)
1. Cerca per email (`lookupByEmail`, su `user_email.address`).
2. Se non esiste e l'email è valida: crea `user` (nome = `name` sanitizzato, o parte locale dell'email), `user_email` default; organizzazione = `org_id` esplicito o organizzazione il cui `domain` contiene il dominio dell'email (`Organization::forDomain`); salva i dati del form utente; segnali `object.created`, `user.created`.
3. Se esiste e `update` → aggiorna info.
Fonti: apertura ticket (web/email/API/staff), staff (`/users/add`, `/users/lookup/form`), import CSV (`name`, `email` obbligatori + campi form; in transazione), registrazione account, aggiunta collaboratori, auto-registrazione da backend esterno.

### 1.3 Account cliente (`user_account`)
- `status` bitmask: CONFIRMED, LOCKED, REQUIRE_PASSWD_RESET, FORBID_PASSWD_RESET.
- Login con **username o email** + password (`osTicketClientAuthentication`, hash bcrypt).
- `backend`: autenticazione esterna (es. LDAP/OAuth) — gli account esterni sono auto-confermati.
- Registrazione:
  - **Self-service** (`account.php`, se `client_registration ∈ {public, auto}`): form utente + password (policy) → `UserAccount::register` → se `client_verify_email=1` invia email `registration-client` con link `pwreset.php?token=<48 char>` (token in `config` ns `pwreset`, valore `c<user_id>`) e l'account resta non confermato (login rifiutato "Account confirmation required") fino al click (`ClientAcctConfirmationTokenBackend`); altrimenti confermato.
  - **Da staff** (`/users/<id>/register`): password temporanea (+ flag "richiedi cambio", "vieta reset") oppure invio email di attivazione.
  - Guest loggato via link può "registrarsi" mantenendo l'email.
- Modalità `client_registration`: `disabled` (tutti guest: il login mostra solo "accesso con email + numero ticket"), `public` (chiunque si registra), `closed` (privata: solo gli agenti registrano), `auto` (auto-registrazione da SSO esterno). Seed: `public`; default codice: `closed`.
- `clients_only=1` ("Require registration and login to create tickets"): il portale richiede login per aprire ticket.
- Lock/unlock, reset password (email `pwreset-client`), forza cambio password, conferma link — azioni staff (`user.manage`).
- Profilo cliente (`profile.php`): dati form utente modificabili dal cliente, timezone, lingua, cambio password (salvo FORBID).

### 1.4 Accesso cliente senza password ("Check ticket status")
`login.php` con email + numero ticket (`AccessLinkAuthentication`): se l'email è owner o collaboratore del ticket → se `client_verify_email=0` accesso immediato (sessione guest su quel ticket), altrimenti invia l'email `access-link` con link tokenizzato. Protetto dal contatore tentativi (strike).
Link tokenizzati nelle email (`view.php?auth=<token>`, `AuthTokenAuthentication`, abilitati da `allow_auth_tokens`): vedi doc 04 §4.4. Legacy: `view.php?t=<number>&e=<email>&a=md5(ticket_id . email . SECRET_SALT)`.

### 1.5 Visibilità ticket per il cliente
- Propri ticket; ticket dove è collaboratore (se `collaborator_ticket_visibility`); ticket dell'organizzazione se l'org condivide (SHARE_EVERYBODY o SHARE_PRIMARY_CONTACT + contatto primario). Filtri lista: Open/Closed/tutti, "My tickets"/"Organization tickets", ricerca per testo/numero.

### 1.6 Gestione utenti staff (`scp/users.php`, `/scp/ajax.php/users/...`)
| Azione | Permesso globale agente |
|---|---|
| Directory utenti, ricerca | `user.dir` (altrimenti solo lookup puntuale nei ticket) |
| Crea / import | `user.create` |
| Modifica dati | `user.edit` |
| Elimina (anche con ticket: `deletetickets`, richiede `ticket.delete`) | `user.delete` |
| Gestione account (registra, lock/unlock, reset password, conferma) | `user.manage` |
Altre: imposta organizzazione (`setorg`), note rapide, form aggiuntivi, export ticket dell'utente, vista ticket dell'utente (`tickets.php?uid=`).

## 2. Organizzazioni

- `organization` + form tipo O → `organization__cdata`.
- Impostazioni (`status` bitmask): condivisione ticket (SHARE_PRIMARY_CONTACT / SHARE_EVERYBODY), collaboratori automatici (COLLAB_ALL_MEMBERS / COLLAB_PRIMARY_CONTACT), auto-assegnazione all'account manager (ASSIGN_AGENT_MANAGER).
- `manager`: `s<staff_id>` o `t<team_id>` (account manager) → alert `*_acct_manager` e auto-assegnazione.
- `domain`: domini email (CSV) per associare automaticamente i nuovi utenti.
- Contatti primari: `user.status` PRIMARY_ORG_CONTACT.
- Permessi globali: `org.create`, `org.edit`, `org.delete`.
- Azioni: aggiungi utente esistente/nuovo, import utenti CSV nell'org, rimuovi utenti, elimina (utenti scollegati), note, form, export ticket.

## 3. Agenti (Staff)

### 3.1 Modello e attributi
Vedi doc 02 (`staff`). Attributi chiave:
- **Reparto primario** + **ruolo primario**; **accessi estesi** (`staff_dept_access`: reparto + ruolo + flag alerts).
- `isadmin` (accesso area Admin; **non** implica permessi sui ticket: questi dipendono dai ruoli), `isactive` (bloccato), `isvisible` (in directory), `onvacation` (non disponibile per assegnazioni/alert), `assigned_only` (vede solo ticket assegnati a sé/ai suoi team: `isAccessLimited()`), `change_passwd`.
- Team (`team_member` con flag alerts).
- **Permessi globali** (`staff.permissions`, vedi §5).
- Preferenze: lingua, timezone, locale, formato data (`datetime_format`), dimensione pagina, refresh, firma + tipo firma default, carta, ordine thread, coda default, nome mittente default (`default_from_name`: mine/dept/email), redirect dopo risposta, vista allegati immagine, spaziatura editor, avatar.
- `extra.def_assn_role`: se l'agente è assegnatario di un ticket in un reparto dove non ha accesso, usa il ruolo primario (default true).
- 2FA: backend default (`default_2fa`) + configurazione per backend (config `staff.<id>`).

### 3.2 Disponibilità e accesso reparti
- `isAvailable()` = attivo **e** non in ferie.
- `getDepts()` = reparto primario + estesi. `canAccessDept($dept)` = non `assigned_only` e reparto in `getDepts()`.
- `getRole($dept, $assigned)` (doc 04 §4.1).
- `getManagedDepartments()` = reparti di cui è manager.
- `isTeamMember($team_id)`, `getTeams()`.

### 3.3 Admin agenti (`scp/staff.php`)
- Crea/modifica: username (univoco, validato), nome, cognome, email (valida, univoca tra agenti, non email di sistema), telefono/interno/mobile, reparto primario (attivo) + ruolo, accessi estesi (reparto, ruolo, alerts), team (con alerts), permessi globali, flag admin/locked/visible/vacation/assigned-only, backend auth, note, password (impostata dall'admin con "cambio obbligato" oppure **email di benvenuto** `registration-staff` con link di reset), uso ruolo primario sugli assegnati.
- Vincolo: deve restare almeno un admin attivo.
- Azioni di massa: abilita, disabilita, elimina, **reset permessi** (applica un set di permessi a più agenti), **cambia reparto** (con opzione di mantenere/eliminare accessi estesi).
- Reset 2FA di un agente (`/staff/<id>/reset-2fa`), impostazione password (`/staff/<id>/set-password`), avatar.
- Export lista agenti.

### 3.4 Profilo agente (`scp/profile.php`)
Modifica propri dati (nome, cognome, **email** (stesse validazioni dell'admin), telefono/interno/mobile, firma (obbligatoria se tipo firma default = mine), timezone, locale, lingua, righe per pagina, refresh code, tipo firma default, formato carta, **in ferie**, avatar, preferenze in `config staff.<id>`), cambio password (`/staff/<id>/change-password`, verifica password attuale e policy), configurazione 2FA (`/staff/<id>/2fa/configure`), preferenze. Forzato se `change_passwd=1` o 2FA richiesta e non configurata.

## 4. Reparti, Team, Ruoli

### 4.1 Reparti (`scp/departments.php`)
Campi: nome (univoco per padre), padre (sotto-reparti, path), stato (Active/Disabled/Archived), tipo pubblico/privato (`ispublic`: selezionabile/visibile ai clienti, firma usabile), SLA, schedule, manager, assegnazione (tutti / solo membri / solo membri primari), disabilita auto-claim, disabilita auto-assegnazione su riapertura, email in uscita, email auto-risposta, template email, alert (`group_membership`: solo primari / primari+estesi / disabilitati / solo admin), auto-risposte (nuovo ticket, nuovo messaggio), firma, membri estesi (con ruolo e alerts).
Azioni di massa: pubblico/privato, abilita, disabilita, archivia, elimina. Disattivare/archiviare un reparto marca i filtri che lo usano; reparti archiviati: ticket non riapribili (`allowsReopen`), esclusi dalle selezioni.
`Dept::getDepartments()` per agente: se l'agente non ha `visibility.departments` vede solo i propri reparti nelle liste di selezione.

### 4.2 Team (`scp/teams.php`)
Nome, stato (enabled), team lead, alerts (NOALERTS), membri (con alerts per membro), note. Eliminazione → `ticket.team_id=0`.

### 4.3 Ruoli (`scp/roles.php`)
Nome univoco, stato, note, **permessi di ruolo** (JSON in `role.permissions`). Il ruolo si applica per reparto (primario o esteso). Eliminabile solo se non usato.

## 5. Permessi

### 5.1 Permessi di RUOLO (valgono nel reparto del ticket/task)
| Gruppo | Chiave | Significato |
|---|---|---|
| Tickets | `ticket.create` | creare ticket (per conto di utenti) nel reparto |
| | `ticket.edit` | modificare ticket (campi, owner, collaboratori, claim da UI) |
| | `ticket.assign` | assegnare/riassegnare |
| | `ticket.release` | rilasciare assegnazione |
| | `ticket.transfer` | trasferire di reparto |
| | `ticket.refer` | condividere (referral) |
| | `ticket.merge` | fondere ticket |
| | `ticket.link` | collegare ticket |
| | `ticket.reply` | rispondere al cliente |
| | `ticket.markanswered` | marcare risposto/non risposto |
| | `ticket.close` | chiudere |
| | `ticket.delete` | eliminare |
| | `thread.edit` | modificare post altrui nel thread |
| Tasks | `task.create`, `task.edit`, `task.assign`, `task.transfer`, `task.reply`, `task.close`, `task.delete` | analoghi per i task |
| Knowledgebase | `canned.manage` | gestire risposte predefinite |

Seed: **All Access** (tutti), **Expanded Access** (tutti tranne `ticket.markanswered`, `ticket.delete`, `task.delete`, `thread.edit`), **Limited Access** (create, merge, link, assign, release, transfer, refer, reply, task.create/assign/transfer/reply — *nota*: nel YAML manca una virgola tra `ticket.reply` e `task.create`, per cui nelle installazioni reali questi due permessi risultano fusi in una chiave inesistente e quindi **assenti**), **View only** (nessuno). Le note interne non richiedono permessi oltre l'accesso.

### 5.2 Permessi GLOBALI dell'agente ("primary", in `staff.permissions`)
| Chiave | Significato |
|---|---|
| `user.create`, `user.edit`, `user.delete`, `user.manage`, `user.dir` | gestione utenti finali e accesso alla directory |
| `org.create`, `org.edit`, `org.delete` | gestione organizzazioni |
| `faq.manage` | gestione KB |
| `emails.banlist` | gestire la ban list |
| `search.all` | nelle ricerche salvate vede **tutti** i ticket (ignora visibilità) |
| `stats.agents` | statistiche di tutti gli agenti in dashboard |
| `visibility.agents` | vedere agenti di tutti i reparti (directory, selezioni) |
| `visibility.departments` | vedere tutti i reparti (selezioni, categorie KB…) |

### 5.3 API dei permessi
- `$staff->hasPerm($perm)` → permesso **globale**.
- `$staff->hasPerm($perm, false)` → il permesso è presente in **almeno un ruolo** dell'agente (primario o esteso); usato per mostrare menu (es. "New Ticket", "New Task").
- `$ticket->checkStaffPerm($staff, $perm)` / `$task->checkStaffPerm(...)` → accesso + permesso del ruolo nel reparto dell'oggetto.
- `$staff->isAdmin()` → area admin.
- Manager di reparto: poteri extra (marcare overdue, release, markanswered, modificare post del reparto).
- Plugin possono registrare nuovi permessi (`RolePermission::register`).

## 6. Autenticazione

### 6.1 Architettura a backend
`AuthenticationBackend` (registry) → `StaffAuthenticationBackend` / `UserAuthenticationBackend`. Ogni backend: `id`, `name`, `authenticate($username, $password)`, `signOn()` (SSO non interattivo), `login($user, $bk)`, `getUser()` (dalla sessione), `validate($authkey)`, `supportsInteractiveAuthentication()`, `supportsPasswordChange/Reset()`, `getPasswordPolicies()`, `triggerAuth()` (esterni: redirect OAuth).
- `process($username, $password)`: backend consentiti per l'utente (`staff.backend` / `user_account.backend`, se impostato si usa solo quello); prova in ordine; il primo che restituisce un utente e completa `login()` vince; `AccessDenied` interrompe. Fallimento → segnale `auth.login.failed` + audit (strike).
- `processSignOn()`: SSO (es. HTTP header, OAuth callback).

Backend core agenti: `local` (password locale), `pwreset.staff` (token di reset), `authstrike.staff` (contatore tentativi). Clienti: `client` (locale), `authtoken` (link email), `authlink` (email + numero ticket), `pwreset.client`, `confirm.client` (conferma account), `authstrike.user`. Plugin: LDAP/AD, OAuth2 (Google, Microsoft…), HTTP passthrough.

### 6.2 Login agente (`scp/login.php`)
1. CSRF obbligatorio, **rotazione del token CSRF ad ogni tentativo** (anti brute force).
2. `userid` (username o email) + `passwd` (max 128 char) → `StaffAuthenticationBackend::process`.
3. `login()`: verifica backend consentito, logga, segnale `person.login`; se l'agente ha un backend 2FA → `send()` (es. invia codice email) e marca la sessione "2FA pending"; sessione: `$_SESSION['_auth']['staff'] = {id, key: '<bk>:<username>', 2fa}`; `TIME_BOMB` = rigenerazione ID sessione dopo 10 s; token di sessione; annulla token di reset; `onLogin` (lastlogin, lingua browser).
4. Se 2FA pending → form codice (`do=2fa`); `ExpiredOTP` (scaduto 6 min o >3 tentativi) → logout.
5. Policy password al login (`onLogin`): password scaduta (`passwd_reset_period` mesi) o non conforme → `change_passwd=1` → profilo forzato.
6. Risposta JSON se `ajax=1` (login inline da sessione scaduta).
7. Legacy: password MD5 riconosciute e riconvertite in bcrypt al login.

### 6.3 Lockout (strike)
- Contatori **in sessione** (`_auth.staff.strikes`/`laststrike`, `_auth.user.*`).
- Superati `staff_max_logins` (default 4) / `client_max_logins` (4) tentativi falliti → blocco per `staff_login_timeout` / `client_login_timeout` minuti (default 2; nota: il backend utenti usa erroneamente il timeout staff), log warning/error e alert admin se `send_login_errors`; ogni 3 tentativi falliti log warning.
- Debolezza: legato alla sessione (non all'IP/account).

### 6.4 Reset password
- Agente (`scp/pwreset.php`): richiede username/email → se `allow_pw_reset=1` invia `pwreset-staff` con token (48 char, `config pwreset`, valore = staff_id); validità `pw_reset_window` minuti (default 30); `PasswordResetTokenBackend` logga l'agente con `change_passwd=1` e lo porta a cambiare password.
- Cliente (`pwreset.php`): analogo con `pwreset-client`, valore `c<user_id>`; vietato se FORBID_PASSWD_RESET.
- Token puliti dal cron dopo la finestra.
- Cambio password → segnale `auth.clean` → **invalida tutte le altre sessioni** dell'utente (DELETE da `session` per `user_id` agente o per regex sui dati sessione del cliente).

### 6.5 Hash password
`Passwd::hash()` = phpass `PasswordHash` (work factor 8, non portable) → **bcrypt** (`$2y$`/`$2a$`). Fallback lettura MD5 legacy. Policy di default (`osTicketPasswordPolicy`): lunghezza 6–128, diversa dalla precedente (case-insensitive), scadenza opzionale. Policy aggiuntive via plugin (selezionabili per agenti/clienti: `agent_passwd_policy`, `client_passwd_policy`).

### 6.6 2FA
- Backend registrati (`TwoFactorAuthenticationBackend::register`): core **Email** (`2fa-email`: codice numerico 6 cifre inviato via email con il contenuto `email2fa-staff`, valido 6 minuti, max 3 tentativi; OTP in sessione `_2fa`); plugin: TOTP (Google Authenticator), ecc.
- Configurazione per agente nel profilo; `require_agent_2fa=1` obbliga tutti gli agenti a configurarla.
- Sessione con 2FA pending → `StaffSession::isValid()` false finché non validato.

## 7. Sessioni

- Cookie `OSTSESSID` (nome configurabile), path `ROOT_PATH`, dominio corrente, `Secure` se HTTPS, `HttpOnly`; TTL = min(`SESSION_TTL` 86400, `session.gc_maxlifetime`).
- Storage: **database** (tabella `session`, default), `memcache`, `memcache.database`, `database.memcache`, `system`. Sessioni API "stateless" (nuove sessioni non persistite).
- Idle timeout: agenti `staff_session_timeout` minuti (default 30; 0 = nessuno), clienti `client_session_timeout` (30). Implementato con un **token di sessione** `md5(time . SESSION_SECRET . userId):time:md5(IP)` in `$_SESSION[':token'][staff|client]`, rinnovato al massimo ogni 60 s; scaduto → sessione non valida → login. Il cookie viene rinnovato con la scadenza.
- `staff_ip_binding=1` → la sessione agente è valida solo dallo stesso IP.
- Anti session-fixation: `TIME_BOMB` → `session_regenerate_id` 10 s dopo il login (solo su GET) e poi ogni idle-time; la vecchia sessione riceve `TTD` (time to die) di 120 s.
- `session.user_id` = id agente (per elenco "chi è online", forzare logout, pulizia).
- Cron: elimina sessioni scadute.

## 8. CSRF
- Un token per sessione (`$_SESSION['csrf']`), `sha1(session_id . random16 . SECRET_SALT)`, senza scadenza (timeout 0).
- Richiesto su ogni POST/PUT/PATCH/DELETE di portale e pannello staff (campo `__CSRFToken__` o header `X-CSRFToken`, che il JS aggiunge leggendo `<meta name="csrf_token">`).
- Ruotato ad ogni tentativo di login.
- Link token GET (`getLinkToken` = md5(csrf . SECRET_SALT . session_id)) per alcune azioni via link.

## 9. ACL IP
`acl` (lista IP) + `acl_backend` (doc 01 §5.3). Confronto esatto IP (dopo risoluzione proxy fidati).

## 10. Avatar
`client_avatar` / `agent_avatar`: `gravatar.<mode>` (mm, identicon, monsterid, wavatar, retro, blank) oppure `local` (iniziali/immagine caricata) o sorgenti plugin. `enable_avatars` attiva gli avatar in thread/code.
