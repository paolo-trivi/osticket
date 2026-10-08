# 17 — Contratto di scrittura (coesistenza PHP ↔ Next.js)

Questo documento elenca, **operazione per operazione**, le righe che osTicket PHP scrive nel database. La nuova app Next.js (`frontend-next/`) deve produrre **le stesse righe**, così il pannello PHP continua a funzionare sugli stessi dati.

Ogni voce è verificata dall'**harness differenziale** (`frontend-next/test/diff/`, comando `npm run test:diff`):
1. si clona il DB di sviluppo in uno snapshot;
2. la stessa operazione viene eseguita con il codice PHP originale (`test/diff/php/runner.php`) su una copia e con il servizio TypeScript sull'altra;
3. si confrontano tutte le tabelle, con i datetime "recenti" normalizzati a `<NOW>`.

Una nuova operazione si considera conforme solo quando ha uno scenario differenziale verde.

## 0. Regole generali (valgono per ogni scrittura)

| Regola | Origine PHP | Implementazione TS |
|---|---|---|
| Sessione MySQL: `NAMES utf8`, `COLLATION_CONNECTION utf8_general_ci`, `SQL_MODE=''`, `TIME_ZONE='SYSTEM'` | `include/mysqli.php` `db_connect()` | `src/server/db/index.ts` (`SESSION_INIT`) |
| `created`/`updated`/`lastlogin`… valorizzati con `NOW()` lato SQL | `SqlFunction::NOW()` | costante `NOW` |
| Date calcolate (scadenze SLA ecc.) in formato `Y-m-d H:i:s` nel **fuso del DB** | `Ticket::getSLADueDate()` | `toDb()` in `src/server/db/time.ts` |
| JSON codificati come `json_encode()` di PHP (`\/`, `\uXXXX`) | `JsonDataEncoder::encode` | `phpJsonEncode()` |
| Nessun carattere a 4 byte (tabelle utf8 a 3 byte) | `Format::strip_emoticons` + charset | `stripFourByteChars()` |
| Password: bcrypt `$2a$08$` (phpass); MD5 legacy riconvertito al primo login | `Passwd`, `Staff::check_passwd` | `src/server/auth/passwd.ts` |
| La tabella `session` (sessioni HTTP PHP) **non** è condivisa: Next usa cookie firmati propri | `class.ostsession.php` | `src/server/auth/session.ts` |
| Nuovi dati di configurazione della app Next: solo **righe** in `config` con namespace `nextui.*` (mai tabelle nuove) | `Config` (namespace come per i plugin) | `src/server/theme/theme.ts` |

## 1. Operazioni implementate

### 1.1 Login agente riuscito — `StaffAuthenticationBackend::process` → `login()`
| Tabella | Scrittura |
|---|---|
| `staff` | `extra` = JSON esistente + `browser_lang` (lingua corrente: `staff.lang` o `core.system_language`); `lastlogin = NOW()`; `updated = NOW()` (`Staff::onLogin`, `Staff::save` imposta `updated` se il record è modificato) |
| `staff` | se l'hash era MD5: `passwd` = nuovo bcrypt (`check_passwd`) |
| `config` | `DELETE WHERE namespace='pwreset' AND value=<staff_id>` (`cancelResetTokens`) |
| `syslog` | solo se `core.log_level >= 3`: riga `Debug`, titolo `Agent Login`, testo `<username> logged in [<ip>], via osTicketStaffAuthentication`, `logger=''` |

Scenari differenziali: login con username, login con email, log di debug attivo → **identici**.

### 1.2 Login agente fallito — `StaffAuthStrikeBackend::authStrike`
| Condizione | Scrittura |
|---|---|
| tentativi ≤ `staff_max_logins` e non multipli di 3 | nessuna |
| ogni 3° tentativo | `syslog` `Warning` "Failed agent login attempt (<username>)" (se `log_level >= 2`) |
| tentativi > `staff_max_logins` | `syslog` `Warning` "Excessive login attempts (<username>)" + blocco per `staff_login_timeout` minuti; email all'admin se `send_login_errors` (**da fare**: richiede il mailer, M2) |

Differenza voluta: il PHP conta i tentativi nella sessione (aggirabile scartando il cookie, doc 14 §2.3); Next li conta per IP + username, in memoria. Il DB non cambia.
Scenario differenziale: password errata → **nessuna scrittura** da entrambe le parti.

### 1.3 Logout agente
| Tabella | Scrittura |
|---|---|
| `syslog` | solo se `log_level >= 3`: `Debug` "Agent logout", `<username> logged out [<ip>]` |

### 1.4 Tema della nuova interfaccia (solo Next)
| Tabella | Scrittura |
|---|---|
| `config` | namespace `nextui.theme`, una riga per chiave: `primary_color`, `mode_default`, `allow_user_mode`, `sidebar_style`, `font`, `radius`, `density`, `app_name`, `login_tagline`, `use_osticket_logos`; insert se manca, update di `value` e `updated=NOW()` solo se cambia (stessa semantica di `Config::set`) |

Il PHP non legge questo namespace. I loghi **non** vengono duplicati: si usano `core.staff_logo_id`, `core.client_logo_id`, `core.staff_backdrop_id`, gestiti dal pannello classico.

## 2. Operazioni da specificare (backlog per milestone)

Per ognuna, prima di implementarla, aggiungere qui la tabella delle scritture (dal codice `include/class.*.php`) e uno scenario in `test/diff/`.

| Milestone | Operazione | Metodo PHP di riferimento |
|---|---|---|
| M2 | risposta agente | `Ticket::postReply` |
| M2 | nota interna | `Ticket::postNote` |
| M2 | cambio stato / chiusura / riapertura | `Ticket::setStatus` |
| M2 | assegnazione, claim, rilascio | `Ticket::assign`, `claim`, `release` |
| M2 | trasferimento, referral | `Ticket::transfer`, `refer` |
| M2 | lock | `Lock::acquire`, `Ticket::acquireLock` |
| M2 | modifica campi, priorità, SLA, scadenza | `Ticket::update`, `updateField` |
| M2 | merge / link | `Ticket::merge`, `link` |
| M2 | cancellazione | `Ticket::delete` |
| M2 | bozze | `Draft::create/update` |
| M2 | allegati | `AttachmentFile::create`, `Attachment` |
| M3 | creazione ticket (tutte le origini) | `Ticket::create`, `Ticket::open` |
| M3 | task | `Task::create`, `Task::setStatus`… |
| M3 | utenti e organizzazioni | `User::fromVars`, `UserAccount::register`, `Organization::fromVars` |
| M4 | messaggio del cliente dal portale | `Ticket::postMessage` |
| M4 | registrazione / reset password cliente | `UserAccount`, `ClientPasswordResetTokenBackend` |
| M5 | ogni salvataggio dell'area admin | `*::update` delle classi admin, `OsticketConfig::updateSettings` |
