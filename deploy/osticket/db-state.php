<?php
/**
 * Stato del database osTicket: stampa "empty" (nessuna tabella osTicket), "installed" o "unreachable".
 * Uso: php db-state.php  (usa OST_DB_HOST/PORT/NAME/USER/PASS e OST_TABLE_PREFIX)
 */
mysqli_report(MYSQLI_REPORT_OFF);
$g = fn($k, $d) => (getenv($k) !== false && getenv($k) !== '') ? getenv($k) : $d;
$db = @new mysqli($g('OST_DB_HOST', 'db'), $g('OST_DB_USER', 'osticket'), $g('OST_DB_PASS', ''), $g('OST_DB_NAME', 'osticket'), (int) $g('OST_DB_PORT', '3306'));
if ($db->connect_errno) { echo "unreachable\n"; exit(1); }
$prefix = $db->real_escape_string($g('OST_TABLE_PREFIX', 'ost_'));
$r = $db->query("SHOW TABLES LIKE '{$prefix}config'");
if (!$r || !$r->num_rows) { echo "empty\n"; exit(0); }
$r = $db->query("SELECT value FROM `{$prefix}config` WHERE namespace='core' AND `key`='schema_signature'");
echo ($r && $r->num_rows) ? "installed\n" : "empty\n";
