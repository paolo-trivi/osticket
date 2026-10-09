<?php
/**
 * Runner PHP dedicato al test differenziale delle scadenze SLA (test/diff/sla.diff.test.ts).
 * Calcola con il codice ORIGINALE di osTicket le scadenze per una lista di casi e le stampa in JSON.
 *
 * Uso: php sla-runner.php <dir-osticket> <nome-db> < casi.json
 *   casi.json: {"cases": [
 *     {"kind": "grace", "slaId": 1, "grace": 0.5|null, "scheduleId": 3|null, "start": "Y-m-d H:i:s", "tz": "Europe/Rome"},
 *     {"kind": "ticket", "slaId": 1, "deptId": 2, "created": "Y-m-d H:i:s", "reopened": null}
 *   ]}
 *   - grace:  $sla->addGracePeriod(new DateTime($start, $tz), $schedule) (grace = override in memoria
 *             del grace period, per provare le ore frazionarie che la colonna INT non può contenere)
 *   - ticket: Ticket::getSLADueDate(true) su un ticket in memoria (reparto → SLA → schedule predefinito)
 */
[$_, $root, $dbname] = $argv + [null, null, null];
$input = json_decode((string) stream_get_contents(STDIN), true);
if (!$root || !$dbname || !is_array($input)) {
    fwrite(STDERR, "Uso: php sla-runner.php <dir-osticket> <db> < casi.json\n");
    exit(2);
}

// Bootstrap identico a runner.php: DBNAME definito prima di ost-config.php
define('DBNAME', $dbname);
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE & ~E_DEPRECATED & ~E_USER_DEPRECATED);
ini_set('display_errors', 'stderr');

$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
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
require_once INCLUDE_DIR.'class.sla.php';
require_once INCLUDE_DIR.'class.ticket.php';

$out = [];
foreach ($input['cases'] as $i => $c) {
    try {
        switch ($c['kind']) {
        case 'grace':
            $sla = SLA::lookup($c['slaId']);
            if (isset($c['grace']))
                $sla->grace_period = $c['grace'];
            $schedule = $c['scheduleId'] ? BusinessHoursSchedule::lookup($c['scheduleId']) : null;
            $dt = $sla->addGracePeriod(new DateTime($c['start'], new DateTimeZone($c['tz'])), $schedule);
            $out[] = [
                'date' => $dt->format('Y-m-d H:i:s'),
                'zone' => $dt->getTimezone()->getName(),
                'ts' => $dt->getTimestamp(),
            ];
            break;
        case 'ticket':
            $t = new Ticket(array(
                'ticket_id' => 0,
                'sla_id' => $c['slaId'],
                'dept_id' => $c['deptId'],
                'created' => $c['created'],
                'reopened' => $c['reopened'] ?? null,
            ));
            $out[] = ['due' => $t->getSLADueDate(true)];
            break;
        default:
            throw new Exception("tipo sconosciuto: {$c['kind']}");
        }
    } catch (Throwable $e) {
        $out[] = ['error' => get_class($e).': '.$e->getMessage()];
    }
}

echo json_encode(['ok' => true, 'results' => $out]), "\n";
