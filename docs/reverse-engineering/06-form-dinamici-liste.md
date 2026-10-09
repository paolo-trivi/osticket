# 06 — Form dinamici, campi, liste personalizzate

File: `class.forms.php` (framework form + tipi di campo + widget), `class.dynamic_forms.php` (form persistiti, entry, answer, cdata), `class.list.php` (liste e stati ticket), `scp/forms.php`, `scp/lists.php`, `include/ajax.forms.php`.

## 1. Due livelli di form

1. **Form "in memoria"** (`Form`, `SimpleForm`, `AbstractForm`): un insieme di oggetti `FormField` costruiti in codice. Usati per dialog interni (AssignmentForm, TransferForm, ReferralForm, ClaimForm, ReleaseForm, MarkAsForm, form di configurazione dei campi, di plugin, di azioni filtro, di ricerca avanzata…). Supportano layout a griglia (`GridFluidLayout`), validazione, rendering via widget, `getClean()`.
2. **Form dinamici** (`DynamicForm`, tabella `form`): progettati dall'admin, con campi in `form_field`; istanze compilate in `form_entry` + `form_entry_values` (EAV).

## 2. Tipi di form dinamici (`form.type`)

| Tipo | Classe | Uso | Note |
|---|---|---|---|
| `T` | `TicketForm` | "Ticket Details", **unico**, attaccato ad ogni ticket | campi di sistema `subject`(20), `message`(21, tipo thread), `priority`(22) non eliminabili |
| `U` | `UserForm` | "Contact Information", unico, ogni utente | campi `email`, `name` (memorizzati anche in `user`/`user_email`), `phone`, `notes` |
| `O` | `OrganizationForm` | "Organization Information", unico | `name`, `address`, `phone`, `website`, `notes` |
| `A` | `TaskForm` | "Task Details", unico | `title`, `description` (thread) |
| `C` | `CompanyForm` | "Company Information" (dati azienda per template `%{company.*}`) | entry unica con object_type `C` |
| `G` | `DynamicForm` | form custom, collegabili a help topic (e aggiungibili manualmente a ticket/utenti/org) | |
| `L<list_id>` | form proprietà di una lista custom | valori in `list_items.properties` |

`ensureDynamicDataViews()` garantisce le tabelle `ticket__cdata`, `task__cdata`, `user__cdata`, `organization__cdata` (doc 02).

## 3. Campo dinamico (`form_field`)

Attributi: `type`, `label`, `name` (variabile; univoco nel form; usato come colonna cdata, chiave API, variabile template), `hint`, `sort`, `configuration` (JSON specifico del tipo), `flags` (visibilità/obbligatorietà/maschere, vedi doc 02 §3).

### 3.1 Semantica dei flag (UI admin "Visibility/Required")
Per ogni campo l'admin imposta:
- **Agenti**: visibile (`AGENT_VIEW`), modificabile (`AGENT_EDIT`), obbligatorio (`AGENT_REQUIRED`).
- **Clienti**: visibile (`CLIENT_VIEW`), modificabile (`CLIENT_EDIT`), obbligatorio (`CLIENT_REQUIRED`).
- **Obbligatorio per chiudere** (`CLOSE_REQUIRED`).
- **Abilitato** (`ENABLED`).
- Le maschere `MASK_*` impediscono all'admin di modificare tipo/nome/obbligatorietà/visibilità o di eliminare/disabilitare i campi di sistema.
Metodi: `isVisibleToStaff()`, `isEditableToStaff()`, `isRequiredForStaff()`, `isVisibleToUsers()`, `isEditableToUsers()`, `isRequiredForUsers()`, `isRequiredForClose()`, `isEnabled()`.

### 3.2 Tipi di campo e configurazione

| `type` | Classe | Label | Opzioni `configuration` | Storage (`value` / `value_id`) |
|---|---|---|---|---|
| `text` | TextboxField | Short Answer | `size`, `length` (max), `validator` (`''`,`email`,`phone`,`ip`,`number`,`regex`), `regex`, `validator-error`, `placeholder` | testo |
| `memo` | TextareaField | Long Answer | `cols`, `rows`, `length`, `html` (rich text), `placeholder` | testo/HTML |
| `thread` | ThreadEntryField | Thread Entry | `attachments` (consenti allegati) + config allegati (size, mimetypes, extensions, max) | **non memorizzato** nell'EAV: è il corpo del primo messaggio / descrizione del task |
| `datetime` | DatetimeField | Date and Time | `time` (includi ora), `timezone`, `gmt`, `min`, `max`, `future` | stringa data (`Y-m-d H:i:s` / timestamp) |
| `timezone` | TimezoneField | Timezone | `autodetect`, `prompt` | nome TZ |
| `phone` | PhoneField | Phone Number | `ext` (interno), `digits`, `format` (us/any) | `numero[Xinterno]` |
| `bool` | BooleanField | Checkbox | `desc` | `1`/`0` |
| `choices` | ChoiceField | Choices | `choices` (righe `chiave:etichetta`), `default`, `prompt`, `multiselect` | JSON `{"chiave":"etichetta",...}` |
| `files` | FileUploadField | File Upload | `size`, `mimetypes`, `extensions`, `strictmimecheck`, `max` | JSON `{file_id: nome}`; i file sono collegati come allegati |
| `break` | SectionBreakField | Section Break | — | nessuno (presentazione) |
| `info` | FreeTextField | Information | `content` (HTML), `attachments` | nessuno |
| `priority` | PriorityField | Priority Level | `prompt`, `default` | `value`=descrizione, `value_id`=priority_id |
| `department` | DepartmentField | Department | `prompt` | nome / dept_id |
| `assignee` | AssigneeField | Assignee | `prompt` | nome / `s<id>`/`t<id>` |
| `list-<id>` | SelectionField | (nome lista) | `multiselect`, `widget` (dropdown/typeahead), `prompt`, `default`, `validator-error` | JSON `{item_id: valore}` e `value_id`=item id (se singolo) |
| (interni) `state`, `ticket-flag`, `topic`, `sla`, `timezone` | TicketStateField, TicketFlagField, TopicField, SLAField | usati in ricerca/proprietà stati | | |

Ogni tipo implementa: `parse($raw)` (input utente → PHP), `to_php($value, $id)` (DB → PHP), `to_database($php)` (PHP → `value` o `[value, value_id]`), `toString`, `display` (HTML), `getSearchMethods`/`getSearchQ` (operatori di ricerca), `getFilterData`, `getChanges` (diff per eventi), `validateEntry`, `getConfigurationOptions`, `hasData`, `isPresentationOnly`, `isStorable`, `hasSubFields`/`getSubFields` (es. phone/ext per filtri).

Registrazione tipi: `FormField::$types` + `FormField::addFieldTypes($gruppo, $callable)` (gruppi: "Basic Fields", "Dynamic Fields" = priority/department/assignee, "Custom Lists" = una voce per lista).

### 3.3 Widget
`TextboxWidget`, `TextareaWidget` (Redactor se html), `PhoneNumberWidget`, `ChoicesWidget` (select/Select2/typeahead), `BoxChoicesWidget`, `CheckboxWidget`, `DatetimePickerWidget` (jQuery UI datepicker + timepicker), `TimezoneWidget`, `SectionBreakWidget`, `ThreadEntryWidget` (editor + allegati), `FileUploadWidget` (dropzone + upload AJAX), `FreeTextWidget`, `ColorPickerWidget`, `PasswordWidget`. Nome input HTML = hash del nome campo (`$field->getFormName()`), per evitare collisioni.

### 3.4 Validazione
`Form::isValid($include)`: per ogni campo incluso (`$include` filtra per contesto: web → visibili ai clienti; staff → visibili agli agenti; email → nessuno) verifica required (per contesto), parse, validatori del tipo, `validator` (email/phone/ip/number/regex), lunghezza, vincoli date, file. Errori per campo + `__all__`.

### 3.5 VisibilityConstraint
Solo per form "in memoria" (configurazioni): un campo è mostrato/nascosto in base a una `Q` su altri campi (es. "regex" visibile se `validator == regex`), compilata in JavaScript.

## 4. Entry e risposte

### 4.1 Creazione istanza
`DynamicForm::instanciate($sort, $data)` → `DynamicFormEntry::create()` con una `DynamicFormEntryAnswer` vuota per ogni campo con dati e memorizzabile. `setSource($vars)` imposta la sorgente (POST/vars). `TicketForm::getNewInstance()` = istanza del form T.

### 4.2 Salvataggio `saveAnswers($isEditable)`
- Salva l'entry (`updated=NOW()` se modificata).
- Per ogni risposta: salta campi senza dati / non memorizzabili / presentazionali / non modificabili nel contesto.
- `val = field->to_database(field->getClean())`; array → `value=val[0]`, `value_id=val[1]`; altrimenti `value`.
- File upload: valore JSON `{id: nome}`.
- Eccezione `FieldUnchanged` → risposta non toccata.
- Ogni save di risposta → segnale `model.created/updated` → aggiornamento riga `*__cdata` (`INSERT ... ON DUPLICATE KEY UPDATE`).

### 4.3 Lettura
- `DynamicFormEntry::forTicket($id)`, `forObject($id, $type)`, `forUser`, `forOrganization`.
- `Ticket::getAnswer('nome')` carica tutte le risposte del ticket (`entry.object_type='T'`) indicizzate per nome campo (o `field.<id>`).
- `$entry->getAnswer($name)`, `setAnswer($name, $value, $id)`.
- `getFilterData()` → `field.<id>` (e `field.<id>.<sub>`) per i filtri.
- `getChanges()` → diff `{field_id: [old, new]}` per gli eventi `edited`.
- `addMissingFields()`: in modifica aggiunge risposte vuote per campi aggiunti al form dopo la creazione dell'entry.

### 4.4 Collegamento form ↔ help topic
`help_topic_form`: form G (e il form T con eventuale disabilitazione campi) per topic, ordinati; `extra.disable` = campi disattivati per quel topic. In apertura ticket (`/ajax.php/form/help-topic/<id>` portale, `/scp/ajax.php/form/help-topic/<id>` staff) restituisce l'HTML dei form del topic (staff: campi visibili agli agenti; client: visibili ai clienti) + i campi del form T da nascondere. Topic figli possono usare i form del padre (`FORM_USE_PARENT`).

### 4.5 Form aggiuntivi manuali
Dallo staff: `/tickets/<id>/forms/manage`, `/users/<id>/forms/manage`, `/orgs/<id>/forms/manage` → aggiunge/rimuove/riordina entry di form G sull'oggetto.

### 4.6 Traduzioni
Titolo/istruzioni del form e label/hint dei campi traducibili via `translation` (`form.title.<id>`, `form.instructions.<id>`, `field.label.<id>`, `field.hint.<id>`, choices).

## 5. Admin form (`scp/forms.php`)
- Elenco form (built-in T/U/O/A/C e custom G).
- Modifica: titolo, istruzioni, note; tabella campi con: label, tipo, nome variabile, visibilità/required (flag), ordinamento (drag & drop), eliminazione (se non MASK_DELETE).
- `/scp/ajax.php/form/field-config/<id>` (GET/POST): dialog di configurazione specifica del tipo + flag.
- Aggiunta/rimozione/rinomina campo di un form con cdata → DROP della tabella cdata (ricostruita).
- Eliminazione form custom: solo se `DELETABLE`; elimina form, campi; le entry restano? (il form viene marcato DELETED se in uso).
- Una risposta può essere cancellata per singola entry (`DELETE /form/answer/<entry>/<field>`).

## 6. Liste personalizzate (`list`, `list_items`)

- `DynamicList`: nome, nome plurale, `sort_mode` (`Alpha`, `-Alpha`, `SortCol` = ordine manuale), `masks` (permessi di modifica), note, **form proprietà** (`form.type = 'L<list_id>'`): campi aggiuntivi valorizzati per ogni elemento (`list_items.properties` JSON `{field_id: valore}`).
- `DynamicListItem`: `value`, `extra` (abbreviazione, usata anche nella ricerca), `sort`, `status` (ENABLED, INTERNAL), `properties`.
- Ogni lista diventa un tipo di campo `list-<id>` utilizzabile nei form (SelectionField; widget dropdown o typeahead; multiselect).
- Admin (`scp/lists.php` + `/scp/ajax.php/list/...`): CRUD elementi, abilita/disabilita, import CSV (`value,abbrev,<proprietà>`), anteprima, ricerca.

### 6.1 Lista di sistema "Ticket Status"
- `list.type = 'ticket-status'`, handler `TicketStatusList`: gli elementi sono le righe di `ticket_status` (non `list_items`).
- Form proprietà con campi `state` (TicketStateField: open/closed/archived/deleted — gli stati "privati" archived/deleted visibili solo se abilitati) e `description`.
- Proprietà extra per stati chiusi: `allowreopen`, `reopenstatus`.
- Regole: stato default (`default_ticket_status_id`) e stati INTERNAL non disabilitabili/eliminabili; non eliminabile se ci sono ticket con quello stato; abilitabile solo se ha uno `state`.
- `CustomListHandler::register('ticket-status', 'TicketStatusList')`.

## 7. Form "di sistema" in memoria usati nei dialog

| Form | Campi |
|---|---|
| `AssignmentForm` | `assignee` (AssigneeField: agenti/team ammessi dal reparto, opz. target agents/teams), `refer` (mantieni referral al precedente assegnatario), `comments` |
| `ClaimForm` | come Assignment, assegnatario fisso = me |
| `ReleaseForm` | `sid`, `tid` (checkbox per rilasciare agente/team), `comments` |
| `MarkAsForm` | `comments` |
| `ReferralForm` | `target` (agent/team/dept), `agent`, `team`, `dept`, `comments` |
| `TransferForm` | `dept` (reparti attivi), `refer` (mantieni referral al reparto attuale), `comments` |
| Form edit campo singolo | `field` + `comments` |
