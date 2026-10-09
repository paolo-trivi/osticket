<?php
/**
 * Dati di sviluppo realistici creati con il codice ORIGINALE di osTicket (stesse righe del pannello PHP).
 * Uso: php seed.php <dir-osticket> [numero-ticket]
 * Idempotente sugli agenti/utenti (li riusa); i ticket vengono sempre aggiunti.
 */
$root = rtrim($argv[1] ?? '/home/user/ost-dev/www', '/');
$howMany = (int) ($argv[2] ?? 60);
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');
$_SERVER['REMOTE_ADDR'] = '10.20.0.15';
$_SERVER['HTTP_HOST'] = 'localhost:8080';
$_SERVER['REQUEST_URI'] = '/scp/index.php';
$_SERVER['SCRIPT_NAME'] = '/scp/index.php';
$_SESSION = [];
chdir($root);
require_once $root.'/bootstrap.php';
Bootstrap::loadConfig();
Bootstrap::defineTables(TABLE_PREFIX);
Bootstrap::loadCode();
Bootstrap::connect();
$ost = osTicket::start();
$cfg = $ost->getConfig();
// Gli indirizzi di prova non hanno record MX: niente verifica DNS (solo per questa esecuzione)
$cfg->persist('verify_email_addrs', 0);
require_once INCLUDE_DIR.'class.ticket.php';
require_once INCLUDE_DIR.'class.task.php';
mt_srand(20261009);

function pick(array $a) { return $a[mt_rand(0, count($a) - 1)]; }
function out($s) { fwrite(STDOUT, $s."\n"); }

// --- Agenti -------------------------------------------------------------
$agents = [
    ['mrossi',   'Mario',   'Rossi',   1, 2, ['user.create'=>1,'user.edit'=>1,'user.dir'=>1,'org.create'=>1,'org.edit'=>1,'faq.manage'=>1], 0, [[3, 3]]],
    ['lbianchi', 'Laura',   'Bianchi', 3, 1, ['user.dir'=>1,'stats.agents'=>1], 0, [[1, 2]]],
    ['gverdi',   'Giulia',  'Verdi',   2, 3, ['user.dir'=>1], 0, []],
    ['aesposito','Antonio', 'Esposito',1, 4, [], 1, []],
];
$staffIds = [];
foreach ($agents as [$username, $first, $last, $dept, $role, $perms, $assignedOnly, $ext]) {
    if ($s = Staff::lookup($username)) { $staffIds[$username] = $s->getId(); continue; }
    $staff = Staff::create();
    $errors = [];
    $vars = [
        'username' => $username, 'firstname' => $first, 'lastname' => $last,
        'email' => "$username@ospedale.example", 'phone' => '0874 409' . mt_rand(100, 999),
        'dept_id' => $dept, 'role_id' => $role, 'isvisible' => '1', 'backend' => '',
        'perms' => array_keys($perms), 'timezone' => 'Europe/Rome',
    ];
    if ($assignedOnly) $vars['assigned_only'] = '1';
    if (!$staff->update($vars, $errors)) { out("Agente $username: ".json_encode($errors)); continue; }
    $staff->setPassword('Passw0rd!dev');
    $staff->save();
    foreach ($ext as [$d, $r]) {
        $da = new StaffDeptAccess(['staff_id' => $staff->getId(), 'dept_id' => $d, 'role_id' => $r]);
        $da->save();
    }
    $staffIds[$username] = $staff->getId();
}
// Team "Level I Support": Mario e Laura
foreach (['mrossi', 'lbianchi'] as $u) {
    if (!TeamMember::objects()->filter(['team_id' => 1, 'staff_id' => $staffIds[$u]])->count())
        (new TeamMember(['team_id' => 1, 'staff_id' => $staffIds[$u]]))->save();
}
out('Agenti: '.json_encode($staffIds));

// --- Organizzazioni e utenti ---------------------------------------------
$orgNames = ['Radiologia', 'Cardiologia', 'Laboratorio Analisi', 'Amministrazione', 'Pronto Soccorso'];
$orgs = [];
foreach ($orgNames as $n) {
    $org = Organization::lookup(['name' => $n]) ?: Organization::fromVars(['name' => $n]);
    $orgs[] = $org;
}
$people = [
    ['Francesca Romano', 'f.romano'], ['Luca Ferrari', 'l.ferrari'], ['Sara Colombo', 's.colombo'],
    ['Paolo Ricci', 'p.ricci'], ['Elena Marino', 'e.marino'], ['Davide Greco', 'd.greco'],
    ['Chiara Bruno', 'c.bruno'], ['Marco Gallo', 'm.gallo'], ['Anna Conti', 'a.conti'],
    ['Giorgio De Luca', 'g.deluca'], ['Martina Costa', 'm.costa'], ['Stefano Giordano', 's.giordano'],
];
$users = [];
foreach ($people as $i => [$name, $local]) {
    $email = "$local@ospedale.example";
    $user = User::lookupByEmail($email) ?: User::fromVars(['name' => $name, 'email' => $email, 'phone' => '0874 4' . mt_rand(10000, 99999)]);
    if ($user && !$user->getOrgId()) $user->setOrganization($orgs[$i % count($orgs)]);
    $users[] = $user;
}
out('Utenti: '.count($users));

// --- Ticket ------------------------------------------------------------
$subjects = [
    ['Stampante del reparto non stampa', 'La stampante di rete al secondo piano non stampa da stamattina. Il display segnala "errore 49".'],
    ['Accesso al FSE non funziona', 'Non riesco ad accedere al Fascicolo Sanitario Elettronico: ricevo "credenziali non valide".'],
    ['Richiesta nuovo account per specializzando', 'Serve un account di dominio e l\'accesso al RIS per il nuovo specializzando che inizia lunedì.'],
    ['PC lentissimo in ambulatorio 3', 'Il PC dell\'ambulatorio 3 impiega diversi minuti ad aprire il gestionale.'],
    ['Referti LIS non arrivano in cartella', 'Da ieri i referti di laboratorio non compaiono nella cartella clinica elettronica.'],
    ['Wi-Fi assente in sala riunioni', 'In sala riunioni del terzo piano il Wi-Fi ospiti non è disponibile.'],
    ['Errore invio ordine al magazzino', 'Il gestionale magazzino restituisce un errore all\'invio degli ordini.'],
    ['Telefono IP senza linea', 'Il telefono IP della guardiola non ha linea, il display è spento.'],
    ['Richiesta installazione software DICOM viewer', 'Avremmo bisogno del viewer DICOM sul PC della sala refertazione.'],
    ['Casella email piena', 'La casella condivisa del reparto ha raggiunto il limite e non riceve più messaggi.'],
    ['Badge non abilitato al varco', 'Il badge di un nuovo infermiere non apre il varco del blocco operatorio.'],
    ['Monitor guasto postazione triage', 'Il monitor della postazione triage sfarfalla e a tratti si spegne.'],
];
$replies = [
    'Buongiorno, abbiamo preso in carico la richiesta. Un tecnico passerà in mattinata.',
    'Abbiamo riavviato il servizio: può verificare se ora funziona correttamente?',
    'Il problema è stato risolto. Chiudiamo la segnalazione, ma ci scriva se si ripresenta.',
    'Ci serve il numero di inventario del dispositivo per procedere.',
];
$followups = ['Grazie, ora funziona.', 'Il problema si ripresenta dopo pranzo.', 'Ecco il numero di inventario: INV-2026-0451.'];
$notes = ['Verificato da remoto: servizio di spooling bloccato.', 'In attesa del fornitore per la sostituzione.', 'Possibile problema di rete sullo switch di piano.'];

$topics = [1, 2, 10, 11];
$priorities = [1, 2, 2, 2, 3, 4];
$sources = ['Web', 'Email', 'Phone', 'API'];
$staffObjs = array_map(fn($id) => Staff::lookup($id), array_values($staffIds));
$created = 0;

for ($i = 0; $i < $howMany; $i++) {
    [$subject, $body] = pick($subjects);
    $user = pick($users);
    $errors = [];
    $vars = [
        'name' => (string) $user->getName(), 'email' => (string) $user->getEmail(), 'uid' => $user->getId(),
        'subject' => $subject, 'message' => $body, 'topicId' => pick($topics),
        'priorityId' => pick($priorities), 'source' => pick($sources), 'ip' => '10.20.' . mt_rand(1, 9) . '.' . mt_rand(2, 250),
    ];
    $ticket = Ticket::create($vars, $errors, 'api', false, false);
    if (!$ticket) { out('Ticket: '.json_encode($errors)); continue; }
    $created++;

    $agent = pick($staffObjs);
    $GLOBALS['thisstaff'] = $agent;
    $roll = mt_rand(1, 100);
    if ($roll > 15) $ticket->assignToStaff($agent, '', false);
    elseif ($roll > 8) $ticket->assignToTeam(1, '', false);

    if ($roll > 30) {
        $e = [];
        $ticket->postReply(['response' => pick($replies), 'reply-to' => 'all'], $e, false, false);
    }
    if ($roll > 50) {
        $ticket->postMessage(['message' => pick($followups), 'userId' => $user->getId()], 'Web', false);
    }
    if ($roll % 3 == 0) {
        $e = [];
        $ticket->postNote(['note' => pick($notes), 'title' => 'Nota tecnica'], $e, $agent, false);
    }
    if ($roll > 70) {
        $e = [];
        $ticket->setStatus(TicketStatus::lookup(3), '', $e);
    } elseif ($roll > 62) {
        $ticket->markOverdue(false);
    }
    $GLOBALS['thisstaff'] = null;

    // Distribuisce le date negli ultimi 90 giorni (solo dati di sviluppo)
    $days = mt_rand(0, 90);
    $hours = mt_rand(0, 9);
    $tid = $ticket->getId();
    $thid = $ticket->getThreadId();
    db_query("UPDATE ".TICKET_TABLE." SET created = created - INTERVAL $days DAY - INTERVAL $hours HOUR,
        updated = updated - INTERVAL $days DAY, lastupdate = lastupdate - INTERVAL $days DAY,
        closed = IF(closed IS NULL, NULL, closed - INTERVAL ".max(0, $days - 1)." DAY),
        est_duedate = IF(est_duedate IS NULL, NULL, est_duedate - INTERVAL $days DAY)
        WHERE ticket_id = $tid");
    db_query("UPDATE ".THREAD_TABLE." SET created = created - INTERVAL $days DAY - INTERVAL $hours HOUR,
        lastmessage = lastmessage - INTERVAL $days DAY, lastresponse = lastresponse - INTERVAL $days DAY WHERE id = $thid");
    db_query("UPDATE ".THREAD_ENTRY_TABLE." SET created = created - INTERVAL $days DAY, updated = updated - INTERVAL $days DAY WHERE thread_id = $thid");
    db_query("UPDATE ".THREAD_EVENT_TABLE." SET timestamp = timestamp - INTERVAL $days DAY WHERE thread_id = $thid");
}
out("Ticket creati: $created");

// --- Knowledge base -----------------------------------------------------------
$kb = [
    ['Postazioni di lavoro', 1, [
        ['Come richiedere un nuovo PC', 'Apri un ticket con argomento <b>Report a Problem</b> indicando reparto e numero di inventario.', 1],
        ['Stampante di rete: cosa controllare', '<ol><li>Verifica che sia accesa</li><li>Controlla la carta</li><li>Riavvia la coda di stampa</li></ol>', 2],
    ]],
    ['Applicativi sanitari', 1, [
        ['Accesso al FSE', 'Per accedere al Fascicolo Sanitario Elettronico serve la smart card abilitata.', 1],
        ['Referti LIS non visibili', 'Controlla che la richiesta sia stata accettata dal laboratorio.', 0],
    ]],
    ['Procedure interne IT', 0, [
        ['Reset password di dominio', 'Procedura riservata agli agenti: verifica identità, poi reset da console AD.', 0],
    ]],
];
foreach ($kb as [$catName, $public, $faqs]) {
    if (!($cat = Category::lookup(Category::findIdByName($catName)))) {
        $cat = Category::create();
        $e = [];
        $cat->update(['name' => $catName, 'ispublic' => $public, 'description' => "Articoli: $catName"], $e);
    }
    foreach ($faqs as [$q, $a, $pub]) {
        if (FAQ::findIdByQuestion($q)) continue;
        $faq = FAQ::create();
        $e = [];
        $faq->update(['question' => $q, 'answer' => $a, 'category_id' => $cat->getId(), 'ispublished' => $pub, 'topics' => [10]], $e);
    }
}
out('FAQ: '.FAQ::objects()->count());

// --- Task ---------------------------------------------------------------------
if (!Task::objects()->count()) {
    $taskTitles = ['Sostituire toner', 'Verificare cablaggio di rete', 'Aggiornare driver stampante', 'Contattare fornitore', 'Configurare nuovo account'];
    $admin = Staff::lookup('devadmin');
    $GLOBALS['thisstaff'] = $admin;
    $n = 0;
    foreach (Ticket::objects()->filter(['status__state' => 'open'])->limit(12) as $ticket) {
        $assignee = pick($staffObjs);
        $task = Task::create([
            'object_id' => $ticket->getId(), 'object_type' => 'T',
            'description' => 'Attività collegata al ticket #'.$ticket->getNumber(),
            'default_formdata' => ['title' => pick($taskTitles), 'description' => 'Dettagli attività'],
            'internal_formdata' => ['dept_id' => $ticket->getDeptId(), 'assignee' => $assignee],
        ]);
        if ($task && $n % 4 == 3) {
            $e = [];
            $task->setStatus('closed', '', $e);
        }
        $n++;
    }
    $GLOBALS['thisstaff'] = null;
    out("Task creati: $n");
}
