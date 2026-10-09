<?php
/**
 * Runner PHP dell'harness differenziale: esegue un'operazione con il codice ORIGINALE di osTicket
 * su un database a scelta e stampa il risultato in JSON.
 *
 * Uso: php runner.php <dir-osticket> <nome-db> '<json operazione>'
 *   operazione: {"op": "staff.login", "args": {...}, "ip": "10.0.0.1"}
 */
[$_, $root, $dbname, $json] = $argv + [null, null, null, null];
$op = json_decode((string) $json, true);
if (!$root || !$dbname || !is_array($op)) {
    fwrite(STDERR, "Uso: php runner.php <dir-osticket> <db> '<json>'\n");
    exit(2);
}

// DBNAME definito prima di ost-config.php: la define del file di configurazione viene ignorata
// (PHP emette solo un warning), così osTicket lavora sul database dello snapshot.
define('DBNAME', $dbname);
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');

$_SERVER['REMOTE_ADDR'] = $op['ip'] ?? '127.0.0.1';
$_SERVER['HTTP_HOST'] = $_SERVER['HTTP_HOST'] ?? 'localhost';
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

$result = ['ok' => true];
switch ($op['op']) {
case 'staff.login':
    $errors = [];
    $user = StaffAuthenticationBackend::process(
        $op['args']['login'], $op['args']['password'], $errors);
    $result = $user instanceof Staff
        ? ['ok' => true, 'staffId' => $user->getId()]
        : ['ok' => false, 'error' => $errors['err'] ?? 'invalid'];
    break;

case 'config.set':
    // Prepara lo stato di partenza di uno scenario (stessa modifica su entrambi i DB)
    $c = new Config($op['args']['namespace']);
    foreach ($op['args']['values'] as $k => $v)
        $c->set($k, $v);
    break;

case 'queue.list':
    // Stessa logica di include/staff/templates/queue-tickets.tmpl.php
    $thisstaff = Staff::lookup($op['args']['agent']);
    $GLOBALS['thisstaff'] = $thisstaff;
    $queue = CustomQueue::lookup($op['args']['queue']);
    $tickets = $queue->getQuery();
    $ignoreVisibility = $queue->ignoreVisibilityConstraints($thisstaff);
    if (!$ignoreVisibility || ($ignoreVisibility && ($queue->isAQueue() || $queue->isASubQueue())))
        $tickets->filter($thisstaff->getTicketsVisibility());
    if ($queue->isAQueue() || $queue->isASubQueue())
        $tickets->filter(Q::any(array('ticket_pid' => null, 'flags__hasbit' => Ticket::FLAG_LINKED)));
    TicketForm::ensureDynamicDataView();
    $sorted = false;
    $sort = $op['args']['sort'] ?? null;
    $dir = (int) ($op['args']['dir'] ?? 0);
    if ($sort !== null && is_numeric($sort)) {
        foreach ($queue->getColumns() as $C) {
            if ($C->id == $sort) {
                $tickets = $C->applySort($tickets, $dir);
                $sorted = true;
            }
        }
    }
    if (!$sorted) {
        $qs = null;
        if ($sort && strpos($sort, 'qs-') === 0)
            $qs = QueueSort::lookup(substr($sort, 3));
        $qs = $qs ?: $queue->getDefaultSort();
        if ($qs) $qs->applySort($tickets, $dir);
        else $tickets->order_by('-created');
    }
    $tickets->distinct('ticket_id');
    $limit = (int) ($op['args']['pageSize'] ?? 25);
    $page = (int) ($op['args']['page'] ?? 1);
    $tickets->limit($limit)->offset(($page - 1) * $limit);
    $ids = array();
    foreach ($tickets->values_flat('ticket_id') as $row)
        $ids[] = (int) $row[0];
    $counts = SavedQueue::counts($thisstaff, false);
    $result = ['ok' => true, 'ids' => $ids, 'count' => $counts['q'.$queue->getId()] ?? null];
    break;

case 'ticket.access':
    // Ticket::checkStaffPerm per ogni ticket: accesso e permessi del ruolo effettivo
    $thisstaff = Staff::lookup($op['args']['agent']);
    $GLOBALS['thisstaff'] = $thisstaff;
    $perms = $op['args']['perms'];
    $out = array();
    foreach (Ticket::objects() as $T) {
        $row = array('view' => (bool) $T->checkStaffPerm($thisstaff));
        foreach ($perms as $p)
            $row[$p] = (bool) $T->checkStaffPerm($thisstaff, $p);
        $out[$T->getId()] = $row;
    }
    $result = ['ok' => true, 'access' => $out];
    break;

case 'queue.counts':
    $thisstaff = Staff::lookup($op['args']['agent']);
    $GLOBALS['thisstaff'] = $thisstaff;
    $counts = SavedQueue::counts($thisstaff, false);
    $result = ['ok' => true, 'counts' => $counts];
    break;

default:
    fwrite(STDERR, "Operazione sconosciuta: {$op['op']}\n");
    exit(3);
}

echo json_encode($result), "\n";
