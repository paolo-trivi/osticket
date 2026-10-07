# 03 — Framework interno: ORM, accesso DB, eventi (Signal), router, controller, plugin, punti di estensione

Questo documento descrive l'"infrastruttura" su cui poggia tutto il dominio. In una riscrittura (es. Laravel) questi componenti vengono sostituiti dagli equivalenti del framework, ma **la semantica va preservata** (in particolare: segnali/eventi di audit, materializzazione cdata, cache identità, permessi controller).

## 1. ORM (`include/class.orm.php`)

ORM ispirato a Django. ~3700 righe. Concetti:

### 1.1 Modello (`VerySimpleModel`)

Ogni entità estende `VerySimpleModel` e dichiara `static $meta`:

```php
class Ticket extends VerySimpleModel {
    static $meta = array(
        'table' => TICKET_TABLE,            // nome tabella
        'pk' => array('ticket_id'),         // chiave primaria (anche composta)
        'ordering' => array('-created'),    // ordinamento default ('-' = DESC)
        'defer' => array('body'),           // colonne caricate lazy
        'select_related' => array('user', 'dept'), // JOIN automatici in SELECT
        'view' => false,                    // true = modello su query/view
        'joins' => array(
            'user' => array('constraint' => array('user_id' => 'User.id'), 'null' => true),
            'tasks' => array('reverse' => 'Task.ticket'),            // 1:N
            'thread' => array('reverse' => 'TicketThread.ticket', 'list' => false), // 1:1 inverso
            'entries' => array('constraint' => array("'T'" => 'DynamicFormEntry.object_type',
                                                      'ticket_id' => 'DynamicFormEntry.object_id'),
                               'list' => true),                      // polimorfico
        ),
    );
}
```

Regole dei `joins`:
- `constraint`: mappa `campo_locale => 'Modello.campo_remoto'`. Un valore/chiave tra apici (`"'T'"`) è una **costante** (usata per le relazioni polimorfiche).
- `reverse: 'Modello.relazione'`: relazione inversa; per default `list=true` (1:N) e `null=true`.
- `list: true` → la proprietà restituisce un `InstrumentedList` (collezione lazy con `add()`, `remove()`, `filter()`…); `broker` permette una classe collezione custom (es. `ThreadEvents`, `GenericAttachments`, `QueueColumnListBroker`).
- `null: true` → LEFT JOIN; altrimenti INNER JOIN.
- `constrain` (nel join) → vincoli aggiuntivi nella clausola ON.
- `searchable: false` → esclusa dalla ricerca avanzata.

Ereditarietà: un modello figlio eredita e fonde `meta` del padre (`joins` vengono uniti). Esempi: `TicketThread extends ObjectThread extends Thread`, `MessageThreadEntry extends ThreadEntry`, `MailBoxAccount extends EmailAccount`, `Ticket`/`TicketModel`, `User extends UserModel`, `Organization extends OrganizationModel`, `Task extends TaskModel`, `Role extends RoleModel`.

Stato dell'istanza:
- `$ht`: hashtable dei valori di colonna (+ oggetti relazionati caricati).
- `$dirty`: campi modificati (valore precedente) → solo questi in UPDATE.
- `$__new__`: non ancora salvato → INSERT.
- `$__deleted__`.

API principali:
| Metodo | Semantica |
|---|---|
| `Model::objects()` | nuovo `QuerySet` |
| `Model::lookup($pk)` / `lookup(['campo'=>v])` | un record o `null`; per PK usa prima la **cache identità** |
| `$m->get('campo')`, `$m->campo` | valore; se è una relazione la carica lazy (`lookup`) e la memorizza in `$ht` |
| `$m->set('rel', $obj)` | imposta FK copiando la PK dell'oggetto; marca dirty |
| `$m->save($refetch=false)` | salva prima eventuali oggetti relazionati nuovi; INSERT/UPDATE dei soli dirty; emette `model.created` o `model.updated` + `object.edited` per ogni campo cambiato (escluso `value`/`updated`); dopo INSERT propaga la nuova PK agli oggetti/liste figli ancora non salvati |
| `$m->delete()` | DELETE singolo; emette `model.deleted` |
| `$m->copy()` | clone senza PK |
| `Model::getMeta()` | metadati elaborati (cache APCu 30 min se disponibile, chiave `SECRET_SALT.GIT_VERSION/orm/<Classe>`) |
| `__onload()` | hook dopo idratazione |

### 1.2 QuerySet

Lazy, concatenabile, iterabile, `Countable`, `ArrayAccess`.

```php
Ticket::objects()
  ->filter(['status__state' => 'open', 'dept_id__in' => [1,2]])
  ->exclude(['staff_id' => 0])
  ->filter(Q::any(['isoverdue'=>1, 'duedate__lt'=>SqlFunction::NOW()]))
  ->select_related('user', 'dept')
  ->annotate(['entries_count' => SqlAggregate::COUNT('thread__entries')])
  ->order_by('-created')
  ->limit(25)->offset(50);
```

| Metodo | Effetto |
|---|---|
| `filter(array|Q, ...)` | AND di vincoli (più argomenti = AND di Q) |
| `exclude(...)` | NOT |
| `constrain(['rel' => Q])` | vincolo aggiunto all'ON del join (per LEFT JOIN/aggregati corretti) |
| `order_by('campo', '-campo2')` / `order_by(false)` | ordinamento / disabilita ordinamento default |
| `limit`, `offset` | paginazione |
| `select_related(...)` | JOIN e idratazione dei modelli correlati |
| `values('a','b__c')` | iterazione su array associativi |
| `values_flat(...)` | iterazione su array posizionali |
| `annotate([...])` | colonne calcolate (aggregati con GROUP BY automatico) |
| `aggregate([...])` | solo aggregati (riga singola) |
| `distinct(...)` | |
| `defer(...)` | colonne lazy |
| `lock()` | `SELECT ... FOR UPDATE` (o `LOCK IN SHARE MODE`) |
| `extra(['select'=>[], 'tables'=>[], 'where'=>[], 'order_by'=>[], 'joins'=>[]])` | SQL raw aggiuntivo (usato per full-text) |
| `union($qs)` | UNION |
| `count()` | `SELECT COUNT(*)` (cache) |
| `exists()` | |
| `first()`, `one()` | `one()` lancia `DoesNotExist` / `ObjectNotUnique` |
| `all()` | array |
| `update([...])` | UPDATE di massa |
| `delete()` | DELETE di massa |
| `options([...])` | `nosort`, `nocache`, `found_rows` (SQL_CALC_FOUND_ROWS → `total()`), `indexhint` |
| `asView()` | genera un modello dinamico basato sulla query (sotto-query come tabella) |

**Sintassi dei lookup** (`campo__relazione__campo__operatore`):

| Operatore | SQL MySQL |
|---|---|
| `exact` (default) | `a = b` (`IS NULL` se b null) |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` |
| `contains` | `LIKE '%b%'` (escape) |
| `startswith`, `endswith` | `LIKE 'b%'`, `LIKE '%b'` |
| `like` | `LIKE b` |
| `in` | `IN (...)` o `IN (subquery)` se b è QuerySet |
| `isnull` | `IS NULL` / `IS NOT NULL` |
| `range` | `BETWEEN` |
| `regex` | `REGEXP` |
| `hasbit` | `a & b != 0` |
| `intersect` | `FIND_IN_SET` |

`Q` objects: `new Q([...])`, `Q::any([...])` (OR), `Q::all([...])` (AND), `Q::not([...])`, `$q->negate()`. Valutabili anche in memoria (`$q->evaluate($model)`, usato per condizioni di formattazione delle colonne e per filtrare liste già caricate).

Espressioni SQL:
- `SqlFunction::NOW()`, `SqlFunction::COALESCE(...)`, `SqlFunction::IF(...)`, `SqlFunction::DATE_FORMAT(...)`, qualunque funzione via `__callStatic`.
- `SqlExpression::plus/minus/times/bitand/bitor(...)`, `SqlField('campo')` (riferimento colonna), `SqlCode('raw')`, `SqlInterval::SECOND(n)`/`DAY(n)` (`NOW() - INTERVAL n SECOND`), `SqlCase::N()->when(Q, val)->otherwise(val)`.
- `SqlAggregate::COUNT/SUM/MAX/MIN/AVG(expr, distinct, constraint)`.

### 1.3 Cache identità (`ModelInstanceManager`)

Ogni modello idratato da DB viene memorizzato in una mappa `Classe + PK → istanza` per la durata della richiesta. `lookup(pk)` la consulta prima di interrogare il DB. Svuotabile (`flushCache()`), es. dopo ricostruzione cdata. Effetto importante: due `lookup` dello stesso ticket restituiscono **la stessa istanza**.

### 1.4 InstrumentedList

Collezione lazy di una relazione 1:N. `add($obj)` imposta la FK e salva; `remove($obj)` cancella (o annulla FK); `filter()` restringe; `window()`; `expunge()` cancella tutti; `update([...])`; supporta `count()`, iterazione, `findFirst(criteria)`/`findAll` in memoria.

### 1.5 Compilazione e esecuzione

`MySqlCompiler` traduce QuerySet → SQL con alias `A1, A2…`, gestisce i join a partire dai path (`user__org__name` → JOIN user, JOIN organization), deduplicando join già fatti. L'esecuzione usa **prepared statement mysqli** (`MySqlPreparedExecutor`) con bind dei parametri (`?`), con cast dei tipi secondo i metadati di colonna (`inspectTable` → `SHOW COLUMNS`, cache APCu).

### 1.6 Accesso DB legacy (`include/mysqli.php`)

Funzioni procedurali usate dalle classi più vecchie: `db_query($sql)`, `db_input($val)` (escape + quote; numeri non quotati), `db_fetch_array`, `db_fetch_row`, `db_result`, `db_num_rows`, `db_affected_rows`, `db_insert_id`, `db_count`, `db_autocommit`, `db_rollback`, `db_version`, `db_timezone`. Errori SQL: loggati in `syslog` e (se `send_sql_errors`) email all'admin.

## 2. Eventi: `Signal`

Bus sincrono in-process.

```php
Signal::connect('ticket.created', function($ticket, &$data) {...}, 'Ticket' /* filtro classe */, $checkCallable);
Signal::send('ticket.created', $ticket, $data);
```

### 2.1 Catalogo segnali emessi dal core

| Segnale | Oggetto | Dati | Quando |
|---|---|---|---|
| `model.created` | qualsiasi modello | — | dopo INSERT ORM |
| `model.updated` | modello | `['dirty'=>[campo=>vecchio]]` | dopo UPDATE ORM |
| `model.deleted` | modello | — | dopo DELETE ORM |
| `object.created` | entità di dominio | `['type'=>..., ...]` | creazione via UI/admin (25 punti) — base del plugin di audit |
| `object.edited` | entità/ConfigItem | `['type'=>'edited','key'=>campo, 'orm_audit'=>bool, ...]` | modifica (56 punti) |
| `object.deleted` | entità | `['type'=>'deleted']` | eliminazione (18 punti) |
| `object.view` | ticket/task/user | | visualizzazione |
| `ticket.create.before` | null | `&$vars` | prima della validazione in `Ticket::create` (i plugin possono alterare i dati) |
| `ticket.create.validated` | null | `&$vars` | dopo validazione |
| `ticket.created` | Ticket | | ticket creato (dopo filtri e auto-assegnazioni, prima delle notifiche? vedi doc 05) |
| `ticket.view.more` | Ticket | `&$extras` | menu "More" nella vista ticket (plugin aggiungono voci) |
| `task.created` | Task | | |
| `threadentry.created` | ThreadEntry | | ogni nuovo post (messaggio/risposta/nota) |
| `user.created` | User | | |
| `organization.created` | Organization | | |
| `mail.received` | null | `&$info` | email ricevuta grezza (prima del parse) |
| `mail.decoded` | null | `&$info` | email decodificata |
| `cron` | null | `['autocron'=>bool]` | fine ciclo cron |
| `syslog` | null | `['title','level','level_id','body']` | ogni log |
| `auth.login.succeeded` | User/Staff | | |
| `auth.login.failed` | null | `['username', 'passwd'?]` | |
| `auth.logout`, `person.login`, `person.logout`, `user.login` | | | |
| `auth.pwreset.email`, `auth.pwreset.login`, `auth.pwchange` | | | flusso password |
| `auth.clean` | | | pulizia sessione |
| `session.close` | | | fine sessione |
| `system.install` | | | fine installazione |
| `api` | Dispatcher | | registrazione rotte API |
| `ajax.scp`, `ajax.client` | Dispatcher | | registrazione rotte AJAX |
| `apps.scp`, `apps.admin` | Dispatcher | | registrazione app plugin |
| `export.tables` | | `&$tables` | backup/export DB (CLI) |
| `config.ttfonts` | | `&$fonts` | font aggiuntivi mPDF |
| `agent.audit`, `user.audit`, `agenttab.audit`, `usertab.audit` | | | estensioni UI audit |

### 2.2 Listener registrati dal core

- `model.created/updated` su `DynamicFormEntryAnswer` → aggiorna tabella `*__cdata`.
- `model.created/deleted/updated(name|type)` su `DynamicFormField` → DROP/ricrea `*__cdata`.
- `cron` → `DynamicForm::ensureCdataTables`, `MysqlSearchBackend::IndexOldStuff` (se reindex), plugin.
- `threadentry.created`, `ticket.created`, `user.created`, `organization.created`, `model.updated/deleted` → `SearchInterface` (indicizzazione `_search`).
- `user.auth` (login esterno) → creazione automatica utente.
- `session.close`, `auth.clean` → pulizia.
- `system.install` → creazione tabella `_search` e indicizzazione.

## 3. Router e controller

- Router: vedi doc 01 §7 (`patterns`, `url`, `url_get`, `url_post`, `url_delete`).
- `Controller` (astratto): `access()` (true di default), `exerr($code,$msg)` → `onError` + risposta HTTP + exit.
- `ApiController extends Controller`: gestione API key, parsing JSON/XML/email, `validateRequestStructure`, log errori (senza alert email per evitare loop/DoS).
- `AjaxController extends ApiController`: `staffOnly()` (401 se non agente valido), `json_encode`, `get($var)`. Ogni classe `ajax.*.php` estende `AjaxController`; le azioni controllano manualmente permessi (`$thisstaff->hasPerm(...)`, `$ticket->checkStaffPerm(...)`).
- Risposte AJAX: JSON (`Http::response(200, json, 'application/json')`) oppure frammenti HTML di dialog modali (template `templates/*.tmpl.php`), con codici speciali: **201** = successo "chiudi dialog" (il JS intercetta), **422** = errori di validazione (ri-renderizza il form). Vedi doc 14.

## 4. Configurazione (`Config`)

- `new Config($namespace, $defaults)` carica tutte le righe del namespace. `get($k, $default)` cerca nell'override di sessione → DB → default.
- `set/update($k,$v)` crea o aggiorna la riga (emettendo `object.edited` se cambia).
- `persist($k,$v)` salva solo in sessione (`$_SESSION['cfg:<ns>']`) — es. `db_timezone`.
- Sottoclassi: `OsticketConfig` (core), `PluginConfig` (con form di configurazione), `EmailAccountConfig` (credenziali cifrate), `MySqlSearchConfig`.

## 5. Plugin system (`class.plugin.php`)

### 5.1 Struttura di un plugin
Cartella o `.phar` in `include/plugins/<nome>/` con `plugin.php` che **ritorna un array**:
```php
return array(
    'id' => 'auth:ldap',              // id univoco
    'version' => '0.6.2',
    'ost_version' => '1.17',          // versione minima osTicket (confronto su major)
    'name' => 'LDAP Authentication',
    'author' => '...',
    'description' => '...',
    'url' => '...',
    'plugin' => 'authentication.php:LdapAuthPlugin', // file:classe
    'include' => 'include/',          // opz.
);
```
La classe estende `Plugin` e dichiara `var $config_class = 'MyConfig'` (estende `PluginConfig` con `getOptions()` → campi form).

### 5.2 Ciclo di vita
1. **Scoperta**: `PluginManager::allInfos()` scansiona `include/plugins/*` (dir o phar con firma valida).
2. **Installazione** (admin → Plugins → Add): riga in `plugin`, `enable()`.
3. **Istanze**: un plugin può avere N `plugin_instance` (se `isMultiInstance()`), ciascuna con propria config (`config` namespace `plugin.<pid>.instance.<iid>`) e flag ENABLED. Blacklist multi-istanza: Auth2FA ≤0.3, Audit, S3Storage, FsStorage.
4. **Bootstrap** (ogni richiesta): per ogni plugin installato e compatibile → `init()`; se attivo → per ogni istanza attiva `bootstrap()` (dove il plugin registra backend, segnali, rotte…).
5. **Upgrade automatico** al cambio versione (`__onload`), `uninstall()` con `pre_uninstall`.
6. **Verifica firma** dei phar via DNS TXT `<sha1>.updates.osticket.com` + chiave pubblica `include/plugins/updates.pem` (badge "verified").

### 5.3 Punti di estensione (registry)

| Registry | Metodo | Scopo |
|---|---|---|
| Auth agenti | `StaffAuthenticationBackend::register($bk)` | LDAP, OAuth2/SSO, HTTP auth… |
| Auth utenti | `UserAuthenticationBackend::register($bk)` | |
| 2FA | `TwoFactorAuthenticationBackend::register($class)` | TOTP (Google Authenticator), Email code (core) |
| OAuth2 email | `Oauth2AuthorizationBackend` (in `class.oauth2.php`) | XOAUTH2 per IMAP/SMTP |
| Storage file | `FileStorageBackend::register($char, $class)` | filesystem (`F`), S3… |
| Campi form | `FormField::addFieldTypes($group, $callable)` | nuovi tipi di campo |
| Liste | `CustomListHandler::register($type, $handler)` | liste di sistema (ticket-status) |
| Azioni filtro | `FilterAction::register($class, $group)` | nuove azioni dei filtri |
| Azioni thread | `ThreadEntry::registerAction($group, $action)` | voci menu su un post (edit, resend, mostra email originale…) |
| Permessi | `RolePermission::register($group, $perms)` | nuovi permessi nei ruoli |
| Avatar | `AvatarSource::register($class)` | gravatar, local… |
| Export | `Exporter::register(...)` | formati export |
| Ricerca | `SearchBackend::register($backend)` | motore full-text alternativo |
| Filtri colonne coda | `QueueColumnFilter::register($filter, $group)` | formatter di colonna |
| Annotazioni colonne | sottoclassi `QueueColumnAnnotation` | decorazioni |
| App UI | `Application::registerStaffApp/registerClientApp/registerAdminApp` | voci di menu "Applications" |
| Rotte | segnali `api`, `ajax.scp`, `ajax.client`, `apps.*` | |
| Sessioni | `osTicketSession::registered_backend()` | |

Plugin "ufficiali" tipici (repo separato `osTicket-plugins`): auth-ldap, auth-oauth2, auth-2fa, storage-fs, storage-s3, audit ("Help Desk Audit": consuma i segnali `object.*` e scrive log di audit visibili in `scp/audits.php`).

## 6. Helper trasversali

| Classe | Funzioni chiave |
|---|---|
| `Format` | `htmlchars`, `sanitize($html)` (htmLawed con whitelist; rimuove script/eventi), `html2text`, `strip_emoticons`, `stripExternalImages`, `viewableImages` (sostituisce `cid:` con URL firmati), `datetime/date/time/daydatetime/relativeTime` (ICU + timezone), `file_size`, `slugify`, `json_encode`, `parseRfc2397` (data URI), `shroud` (mascheramento chiavi), `array_implode`, `searchable` |
| `Misc` | `randCode($len, $chars)`, `randNumber($digits)`, `db2gmtime`, `dbtime`, `currentURL`, `__rand_seed` |
| `Http` | `response($code, $body, $ctype)`, `redirect`, `flush`, `cacheable`, `download`, `url`, `header_code_verbose` |
| `Validator` | `process($fields, $vars, &$errors)` (regole: string, int, email, phone, url, ipaddr, cs-url, cs-domain, password, username, zipcode…), `is_email` (con verifica MX opz.), `is_ip`, `check_ip` (CIDR), `check_acl`, `is_username`, `is_url` |
| `Messages` | messaggi flash (ERROR/WARNING/SUCCESS/INFO/DEBUG) in sessione |
| `Pagenate` | paginazione (`getStart`, `getLimit`, `paginate`) |
| `Crypto` | `encrypt($input, $key=SECRET_SALT, $subkey)` / `decrypt`: AES-256-CBC via openssl con HMAC; `Crypto::random($len)` |
| `CSRF` | token per sessione (`__CSRFToken__`), TTL, rotazione |
| `JsonDataParser/Encoder` | JSON con gestione errori |
| `VariableReplacer` | sostituzione `%{a.b.c}` (doc 07) |
| `ListObject` | array-like con `filter`, `findFirst` |

## 7. Pattern di cancellazione (integrità manuale)

Poiché non ci sono FK, ogni `delete()` di dominio ripulisce a mano. Esempi principali (dettagli nei rispettivi documenti):

- **Ticket::delete()**: stato → elimina thread (entries, eventi, collaboratori, referral, allegati orfani), form entries + valori, riga cdata, task collegati? (no: i task restano ma perdono il riferimento? → vedi doc 05), lock, indice di ricerca, emette `object.deleted`; se ha figli (merge) li gestisce.
- **User::delete()**: elimina i ticket dell'utente (opzionale da UI), account, email, form entries, note, collaborazioni.
- **Dept::delete()**: non eliminabile se default o con ticket; azzera `dept_id` su staff? (no: richiede che non abbia membri primari), elimina `staff_dept_access`, aggiorna help topic/email/filtri (flag `INACTIVE_DEPT`).
- **Staff::delete()**: rilascia ticket/task assegnati (staff_id=0), rimuove da team, dept_access, lock, queue personali, config `staff.<id>`; non eliminabile se ultimo admin o se è sé stesso.
- **Topic::delete()**: azzera `topic_id` sui ticket, aggiorna filtri (flag `INACTIVE_HT`), elimina `help_topic_form`, `faq_topic`.
- **DynamicForm::delete()**: solo se DELETABLE; flag DELETED se ha dati.
- **AttachmentFile::deleteOrphans()** (cron): file non referenziati da `attachment` e non logo/backdrop, più vecchi di 1 giorno.
