# 11 — Frontend: portale cliente, pannello agenti, area amministrazione, JavaScript

Rendering 100% server-side PHP (template `.inc.php` / `.tmpl.php` con `<?php echo ?>`), arricchito da jQuery. Nessun framework SPA. Tutti i testi passano da `__()` (gettext). Escape output con `Format::htmlchars()`; HTML utente sanitizzato prima del salvataggio.

## 1. Portale cliente (root `/`, tema `assets/default/`)

### 1.1 Layout
`include/client/header.inc.php`: logo (`logo.php`, logo cliente configurato), titolo helpdesk, selettore lingua (lingue secondarie), stato login ("Guest User | Sign In" / "Nome | Profile | Tickets (N) | Sign Out"), navigazione `UserNav`:
- **Support Center Home** (`index.php`)
- **Knowledgebase** (`kb/index.php`) — se KB abilitata e con FAQ pubbliche
- **Open a New Ticket** (`open.php`)
- **Tickets (N)** (`tickets.php`, solo loggati; N include ticket org se condivisi) oppure **View Ticket Thread** (guest via link)
- **Check Ticket Status** (`view.php`, non loggati)
- Voci app dei plugin.
Footer con "powered by osTicket". Banner messaggi (`$msg`, `$warn`, `$errors['err']`). Meta `csrf_token`. Supporto RTL.

### 1.2 Pagine
| Pagina | Contenuto / comportamento |
|---|---|
| `index.php` | Contenuto pagina "landing" (`landing_page_id`), box ricerca KB (se abilitata), **FAQ in evidenza**, categorie in evidenza, pulsanti "Open a New Ticket" / "Check Ticket Status", sidebar con link a pagine. |
| `open.php` | Form apertura ticket (`open.inc.php`): se guest → form "Contact Information" (email, nome, telefono, …; campi visibili ai clienti); select **Help Topic** (topic pubblici/attivi; al cambio carica via AJAX i form del topic); form "Ticket Details" (subject, message con editor Redactor + allegati drag&drop, priority se visibile, campi custom) + form del topic; **CAPTCHA** (`captcha.php`, immagine GD) se `enable_captcha` e non loggato; bottoni Create / Reset / Cancel. Bozza `ticket.client`. Dopo invio → pagina "thank you" con variabili ticket. Se `clients_only` e non loggato → login. |
| `login.php` | Due box: "Sign in" (username/email + password, link "Forgot password", "Register") e "Check ticket status" (email + numero ticket, `accesslink.inc.php`) — solo il secondo se registrazione `disabled`. Pulsanti dei backend esterni (OAuth). Banner `banner-client`. |
| `account.php` | Registrazione (form utente + timezone + password) / conferma / grazie; per loggati: profilo. |
| `profile.php` | Profilo: campi form utente modificabili, preferenze (timezone, lingua), cambio password (se non vietato). Forzata se reset obbligatorio. |
| `pwreset.php` | Richiesta reset (email/username) → email; link con token → form nuova password; conferma account. |
| `tickets.php` (lista) | `tickets.inc.php`: filtro stato (Open/Closed/All), ambito (My tickets / Organization tickets), ricerca testo; colonne: Ticket # (link), Create Date, Status, Subject, Department (o "Help Topic"); ordinamento per colonna; paginazione. |
| `tickets.php?id=` (vista) | `view.inc.php`: intestazione (numero, oggetto, stato, reparto, data creazione, "Print", "Edit" se ci sono campi modificabili dal cliente); dati utente; risposte dei form visibili ai clienti; **thread** (solo M e R, in ordine, con allegati e immagini inline; nome agente nascosto se `hide_staff_name`; eventi visibili al cliente); form **risposta** (messaggio + allegati; bozza `ticket.client.<id>`; se il ticket è chiuso e riapribile, la risposta lo riapre — avviso mostrato). Elenco collaboratori (CC). |
| `tickets.php?a=edit` | Modifica campi del ticket con flag `CLIENT_EDIT` (solo proprietario) → evento `edited`. |
| `view.php` | Accesso via token (`?auth=`) o legacy; senza token mostra il form email+numero. |
| `kb/index.php`, `kb/faq.php` | KB: categorie, ricerca, FAQ (con allegati, stampa). |
| `pages/<slug>` | Pagine statiche. |
| `offline.php` | Pagina "offline" quando il sistema è disattivato. |
| `file.php`, `avatar.php`, `logo.php`, `captcha.php` | risorse |

## 2. Pannello agenti (`/scp/`)

### 2.1 Layout (`include/staff/header.inc.php`)
Barra superiore: logo staff, "Welcome, <nome>", link **Admin Panel** (se admin) / **Agent Panel**, **Profile**, **Log Out**; selettore lingua. Tab principali (`StaffNav`):
| Tab | Sottomenu |
|---|---|
| **Dashboard** | Dashboard (statistiche), Agent Directory, My Profile |
| **Users** (se `user.dir`) | User Directory, Organizations |
| **Tasks** | (code task: Open, Assigned to me, Overdue, Closed; New Task) |
| **Tickets** | code di sistema di primo livello come sotto-tab con **dropdown** delle sotto-code e contatori (Open ▸ Open/Answered/Overdue; My Tickets ▸ Assigned to Me/Assigned to Teams; Closed ▸ Today…This Year), "My Searches" (ricerche salvate/personali), **New Ticket** (se permesso) |
| **Knowledgebase** | FAQs, Categories (`faq.manage`), Canned Responses (`canned.manage` e premade abilitato) |
| **Applications** | voci dei plugin |
Barra di ricerca rapida con typeahead e link "Advanced". Messaggi di sistema (upgrade pendente, offline, warning) in alto. Autocron `<img src="autocron.php">`. Timeout sessione → dialog di re-login.

### 2.2 Lista ticket (coda) — `templates/queue-tickets.tmpl.php`
- Titolo coda + numero risultati, menu "Sort" (ordinamenti della coda), quick filter (es. reparto), pulsanti "Refresh", "Export", "Edit/Personalize queue", **azioni di massa** (Assign ▸ Me/Agent/Team, Transfer, Refer, Merge, Link, Status ▸ Open/Close/…, Delete) su checkbox selezionate.
- Tabella con le colonne della coda (larghezza, intestazione, decorazioni: icona sorgente, contatore thread, graffetta allegati, bandiera overdue, lucchetto lock, avatar), righe in **grassetto** se non risposte (condizione colonna), anteprima al passaggio del mouse sul numero.
- Paginazione, refresh automatico.

### 2.3 Vista ticket — `ticket-view.inc.php`
- **Header**: `Ticket #<numero>` (+ icona PARENT/CHILD per merge), pulsanti: Edit, Print (dialog: carta, note, eventi), Claim/Assign, Transfer, Refer, Change Status (dropdown stati), **More** (Change Owner, Manage Forms, Manage Referrals, Mark as Answered/Unanswered, Mark as Overdue, Merge Tickets, Link Tickets, Related Tickets, Ban Email, Delete Ticket, voci plugin), Reload; lock indicator.
- **Info panes**: Status, Priority, Department, Create Date | User (nome con menu: Manage User, Manage Organization, Change Owner), Email, Phone, Organization, Source | Assigned To / Closed By, SLA Plan, Due Date, Help Topic, Last Message, Last Response. Molti campi **modificabili inline** (icona matita → dialog `field/<fid>/edit`).
- **Form dinamici** del ticket (risposte, campi obbligatori per chiusura evidenziati).
- Tab **Ticket Thread** | **Tasks (N)** | (Relations).
- **Thread**: entries con avatar, nome, data, badge tipo (messaggio cliente / risposta / nota interna gialla), titolo, corpo, allegati, menu azioni (edit, resend, view headers, create ticket/task), eventi timeline intercalati ("X assigned this to Y …"). Ordine asc/desc da preferenza. Original message evidenziato.
- **Box di risposta** con tab:
  - **Post Reply**: destinatari (To: utente; Cc: collaboratori con checkbox; "Reply To": All Active Recipients / Ticket Owner / Do Not Email Reply), "From" (email di reparto o alternativa), **Premade Replies** (canned), editor (Redactor con bozza, immagini inline, variabili), allegati, firma (None / My Signature / Department), **Ticket Status** dopo la risposta, Post Reply / Reset.
  - **Post Internal Note**: titolo (note details), corpo, allegati, cambio stato, Post Note.
  - Il lock viene acquisito all'inizio della digitazione (modalità 2) e rinnovato; il form contiene `lockCode`.
- **Collaboratori**: icona con conteggio → dialog gestione (attivi/inattivi, aggiungi da ricerca utenti o nuovo).

### 2.4 Apertura ticket da staff — `ticket-open.inc.php`
Ricerca/selezione utente (o creazione inline), **CC**, opzione notifica utente ("Ticket Notice": Alert all / user / none), sorgente (Phone/Email/Other…), Help Topic (carica form), Department, SLA, Due Date, **Assign To**, form Ticket Details (subject, issue details), **Response** opzionale con canned/firma/stato, **Internal Note** opzionale.

### 2.5 Altre schermate agente
- `tasks.php`: coda task + vista task (header con azioni: Edit, Assign/Claim, Transfer, Close/Reopen, Delete, Print; info: Status, Department, Created, Due; thread; risposta/nota).
- `users.php`: directory utenti (ricerca, ordinamento, azioni di massa: lock, unlock, delete, reset password, register, set organization; Add/Import), vista utente (`user-view.inc.php`: info, organizzazione, account status, tab **Tickets**/**Notes**, azioni: Edit, Manage Account, Register, Delete, Merge?).
- `orgs.php`: directory organizzazioni + vista org (Users, Tickets, Notes, Settings: condivisione/collaboratori/account manager/domini).
- `kb.php`/`faq.php`/`categories.php`/`canned.php`: consultazione e gestione KB e canned.
- `directory.php`: rubrica agenti.
- `profile.php`: profilo agente (Account, Preferences, Signature, 2FA).
- `dashboard.php`: grafico eventi + tabelle Department/Topics/Agent con export.

## 3. Area amministrazione (`/scp/` con `admin.inc.php`, `AdminNav`)

| Tab | Sottomenu → pagina |
|---|---|
| **Dashboard** | System Logs (`logs.php`: filtro tipo/data, dettaglio, elimina), Audit Logs (`audits.php`, se plugin audit), Information (`system.php`: versioni PHP/MySQL/osTicket, estensioni, percorsi, dimensioni DB, opzioni) |
| **Settings** | Company (`settings.php?t=pages`: pagine landing/offline/thank-you, logo cliente/staff, backdrop login, info azienda form C), System (`t=system`), Tickets (`t=tickets`, include tab Queues), Tasks (`t=tasks`), Agents (`t=agents`), Users (`t=users`), Knowledgebase (`t=kb`) — + Autoresponder e Alerts dentro Tickets/Emails |
| **Manage** | Help Topics, Filters, SLA, Schedules, API (chiavi), Pages, Forms, Lists, Plugins |
| **Emails** | Emails (indirizzi + account mailbox/SMTP + OAuth), Settings (`emailsettings.php`), Banlist, Templates, Diagnostic (invio test) |
| **Agents** | Agents, Teams, Roles, Departments |
| **Applications** | plugin |

Ogni pagina admin segue lo schema "lista con checkbox + azioni di massa (Enable/Disable/Delete/Sort) + pulsante Add" e "form di dettaglio con tab". Dettaglio campi in doc 13.

## 4. JavaScript principale

| File | Ruolo |
|---|---|
| `js/osticket.js` | comune: CSRF su AJAX (`X-CSRFToken`), inizializzazione editor/campi, upload, utilities |
| `scp/js/scp.js` | pannello staff: `$.dialog`, `$.sysAlert`, `$.confirm`, PJAX, typeahead ricerca, gestione check-all + azioni di massa, refresh coda, quick-add, timeout sessione, contatori code |
| `scp/js/ticket.js` | vista ticket: lock (`$.lock`), autosave risposta, canned response, collaboratori, gestione tab, print |
| `scp/js/thread.js` | rendering thread: immagini inline, espansione citazioni, azioni entry |
| `js/redactor-osticket.js` + `redactor-plugins.js` | integrazione editor: bozze (autosave su `/ajax.php/draft/...`), upload immagini, autocompletamento variabili `%{`, canned, firma, fullscreen, tabelle, definizioni lingua |
| `js/filedrop.field.js` | upload drag&drop |
| `js/jquery.pjax.js` | navigazione parziale |
| `scp/js/dashboard.inc.js` | grafico statistiche (Raphael/gRaphael) |
| `scp/js/tips.js` | help tips (`?` icone → `/ajax.php/help/tips/<ns>`) |
| `scp/js/upgrader.js` | upgrade a step |
| `scp/js/jquery.translatable.js` | traduzioni inline dei campi (lingue secondarie) |
| librerie | jQuery 3.7, jQuery UI 1.13 (datepicker, sortable, dialog), Select2, bootstrap-typeahead/tooltip/tab, spectrum, fabric (annotazioni immagini), jstz |

## 5. Stile
CSS: `css/osticket.css`, `css/thread.css`, `scp/css/scp.css`, `assets/default/css/theme.css` (+ LESS), Font Awesome 3. Il tema cliente è personalizzabile (`assets/default/about-custom-themes.md`).
