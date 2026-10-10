# Contratto di scrittura — area "portal" (M4: portale clienti)

Riferimenti PHP: root `index.php`, `login.php`, `logout.php`, `view.php`, `account.php`, `pwreset.php`,
`profile.php`, `open.php`, `tickets.php`, `kb/*`; `include/class.auth.php` (UserAuthenticationBackend,
UserAuthStrikeBackend, osTicketClientAuthentication, AccessLinkAuthentication, AuthTokenAuthentication,
ClientPasswordResetTokenBackend, ClientAcctConfirmationTokenBackend), `class.client.php` (TicketUser,
EndUser, ClientAccount), `class.user.php` (User::updateInfo, UserAccount), `class.ticket.php`
(postMessage, onMessage, notifyCollaborators, sendAccessLink, checkUserAccess), `include/client/*.inc.php`.
Diff test: `test/diff/portal-auth.diff.test.ts` (20), `portal-message.diff.test.ts` (13),
`portal-open.diff.test.ts` (5) con le op di `test/diff/php/ops/portal.php`.

## API

```ts
// Sessione (src/server/auth/client-auth.ts) — cookie firmato `ostn_client` (realm "client"), separato dagli agenti
startClientSession(login: ClientLogin)        currentClient(): ClientIdentity | null   (cache per richiesta)
touchClientSession() clientSessionKey() visitorKey(create?) clientResetToken() refreshClientSession(pwv) clientLogout()

// Autenticazione (src/server/domain/client/auth*.ts) — solo dominio, usabili dall'harness
// auth.ts: tipi (ClientLogin, ClientAuthError), tentativi falliti (strike), scritture del login (loginWrites)
performClientLogin({login, password, ip})            → ClientAuthOutcome                       // auth-login.ts
performAccessLink({email, number, ip})               → {ok, sent:true} | {ok, sent:false, ...ClientLogin} | errore   // auth-access-link.ts
performTokenSignOn({auth | t,e,a, ip})               → ClientAuthOutcome | null                // auth-access-link.ts
performResetTokenLogin({userid, token, ip})          → ClientAuthOutcome (resetToken in sessione)   // auth-reset.ts
performConfirm({token, ip})                          → ConfirmOutcome                          // auth-confirm.ts
lookupByAuthToken(executor, token) (auth-access-link.ts)  resetTokenValid(executor, cfg, token, userId) (auth-reset.ts)

// Account (src/server/domain/client/{account,profile-info,password-reset}.ts)
registerClientAccount(vars, guest?)  updateClientProfile(client, vars, resetToken?)
updateUserInfoForClient(tx, cfg, userId, input)  requestClientPasswordReset(userid, {pad?})

// Ticket (src/server/domain/ticket/message.ts, domain/client/*)
postMessage(ctx, {ticketId, userId, poster, message, files?, origin?, alerts?})   // Ticket::postMessage
postClientMessage(cfg, client, ticketId, {message, files, ip})                    // tickets.php a=reply
editClientTicket(cfg, client, ticketId, vars, ip) / editTicketAsClient(ctx, ...)     // tickets.php a=edit
openPortalTicket(cfg, client|null, vars, {ip, sessionKey})                        // open.php → createTicket 'web'
clientCanAccess, listClientTickets, clientTicketStats, loadClientTicketView, clientAttachment, clientEditForms
kbEnabled, publicCategories, featuredCategories, searchFaqs, publicCategory, publicFaq, publicFaqFile, contentPage
```

Rotte: pagine in `src/app/[locale]/(client)/**` (`/`, `/login`, `/account`, `/pwreset`, `/profile`, `/tickets`,
`/tickets/[id]`, `/tickets/[id]/edit`, `/open`, `/kb`, `/kb/category/[id]`, `/kb/faq/[id]`); route handler
`/view` (link `?auth=`), `/pwreset/confirm` (conferma account), `/api/portal/upload`, `/api/portal/file/[key]`.

## Scritture

| Operazione | Righe |
|---|---|
| Login riuscito (client, token, link senza verifica, reset, conferma) | `syslog` Debug "User login" `<email> (<uid>) logged in [<ip>]` (solo con log_level ≥ 3); `user_account.extra` `{"browser_lang":"<lingua di sistema>"}` se l'utente ha un account e il valore cambia; solo login interattivo: `DELETE config` namespace `pwreset` value `c<uid>`; password MD5 legacy → `user_account.passwd` bcrypt `$2a$08$` |
| Login fallito / AccessDenied | contatore per IP (il PHP: per sessione); ogni 3° tentativo `syslog` Warning "Failed login attempt (user)"; oltre `client_max_logins` blocco per `staff_login_timeout` minuti, `syslog` Error "Excessive login attempts (user)" + avviso all'admin (solo testo) se `send_login_errors` |
| Link di accesso (verifica email) | nessuna riga; email pagina `access-link` (to: proprietario con `view.php?auth=`; cc: collaboratore con `tickets.php?id=`) dall'email predefinita, Message-ID classe `?` utente 0 |
| Registrazione (account.php) | utente nuovo come `User::fromVars` (user, user_email, form_entry U + valori + `user__cdata`, `_search` U); utente esistente: `User::updateInfo`; `DELETE config pwreset c<uid>`; `INSERT user_account` (user_id, timezone, lang NULL, passwd, status 0); `INSERT config` pwreset `<token 48>` = `c<uid>`; email `registration-client` |
| Conferma (pwreset.php?token) | `user_account.status \|= 1`; login (sopra); con password locale `DELETE config pwreset c<uid>`, altrimenti `status \|= 4` |
| Richiesta reset | `INSERT config` pwreset `<token>` = `c<uid>`; email `pwreset-client`; nessuna scrittura se l'account non esiste |
| Accesso con token di reset | `user_account.status \|= 4` (REQUIRE_PASSWD_RESET), login (sopra) senza cancellare il token |
| Profilo | `user_account` timezone/lang (solo se cambiano), con nuova password: passwd, `DELETE config pwreset c<uid>`, `status &= ~4`; `User::updateInfo`: `user_email.address`, `form_entry_values` dei campi modificabili dai clienti (`user__cdata`), `user.name` normalizzato + `updated`, `_search` U |
| Messaggio (postMessage) | poster ≠ proprietario e non collaboratore: `thread_collaborator` flag 3 + evento `collab`; `thread_entry` M (recipients = partecipanti attivi tranne il poster, ordine collaboratori per nome; flag REPLY_ALL/REPLY_USER, COLLABORATOR, BALANCED), `_search` H, `attachment` H; `thread.lastmessage`; `ticket` isanswered 0, lastupdate, updated; se chiuso e riapribile `Ticket::reopen` (status, reopened, closed NULL, staff riassegnato, evento `reopened` che annulla `closed`, est_duedate); `DELETE draft` `ticket.client.<id>` (+ allegati D) |
| Modifica ticket (a=edit) | `form_entry_values` dei campi visibili e modificabili dai clienti + `ticket__cdata`; evento `edited` `{"fields":{"<id>":[vecchio,nuovo]}}` con l'utente (uid U) — senza `ticket.updated` né `_search`. Date nel fuso del cliente (`$cfg->getTimezone()`); un campo assente dal POST mantiene la risposta (validata e salvata come `getClean()`), ma nell'evento compare con nuovo valore `null` (`getChanges`, stranezza replicata) |
| Apertura (open.php) | `DELETE draft ticket.client.<ultimi 12 della sessione>` (anche se la creazione fallisce) poi `createTicket(ctx, vars, "web")` (vedi `create.md`) |

Email del messaggio (dopo il commit, ordine del PHP): `message.autoresp` al poster (proprietario in To classe U,
collaboratore in Cc classe C; `message_autoresponder` e reparto `message_auto_response`), `ticket.activity.notice`
(una email: proprietario in To, collaboratori in Cc, classe M; saluto "Collaborator" se il proprietario è l'autore),
`message.alert` agli agenti (penultimo rispondente, assegnatario o team, manager del reparto, account manager).

KB: sola lettura, il PHP non registra visualizzazioni (nessuna colonna `faq.views`).

## Differenze rispetto al PHP (sicurezza, non replicate)
- Strike per IP (in memoria) invece che per sessione: scartare il cookie non azzera il contatore.
- `ClientAccount::update` con token di reset: il PHP non verifica scadenza del token (`&&` al posto di `||`),
  conferma e politica della password; qui token valido e non scaduto, conferma e politica obbligatorie.
- Registrazione/apertura ospite: `Company` legge i propri campi da `$_POST` al primo uso, quindi `%{company.name}`
  nell'email di conferma diventa il nome inviato dal visitatore (contenuto falsificabile verso indirizzi arbitrari);
  Next usa sempre i dati dell'azienda (l'op PHP carica Company prima di `$_POST`).
- Ricerca dei ticket: le note interne non partecipano alla ricerca full-text del cliente.
- Un ospite (link) vede solo il ticket del link; non può modificare il profilo.
- Captcha (`enable_captcha`) non replicato: con il captcha attivo gli ospiti non aprono ticket da Next.
- AccessLinkAuthentication provata nel login con password (password = numero di un proprio ticket): non replicato.

## Stranezze PHP replicate
- `UserAuthStrikeBackend::authTimeout` usa `staff_login_timeout`, non `client_login_timeout`.
- Ogni tentativo durante il blocco è un nuovo strike (nuovo "Excessive login attempts").
- `ClientPasswordResetTokenBackend::signOn` riceve `$errors` per valore: l'errore mostrato è "Unknown user" (+ strike).
- Il controllo anti-loop dell'auto-risposta (`Email::getIdByEmail('"Nome" <email>')`) non trova mai un'email di sistema.
- `getChanges` della modifica cliente include anche i campi non visibili/modificabili assenti dal POST (es. priorità → null) nell'evento, ma salva solo i campi del cliente.
- Testo semplice: doppia pulizia del corpo (tickets.php + ThreadEntry::create) senza doppia codifica.
- `user_account` non ha `lastlogin`: il PHP non registra l'ultimo accesso dei clienti.
- Lingua `browser_lang`: lingua di sistema (la negoziazione con Accept-Language non è replicata).
