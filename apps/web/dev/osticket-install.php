<?php
/**
 * Installazione non interattiva di osTicket (stesso codice dell'installer web).
 * Uso: php osticket-install.php <dir-installazione-osticket>
 * Variabili d'ambiente: OST_DB_HOST, OST_DB_NAME, OST_DB_USER, OST_DB_PASS,
 * OST_PREFIX, OST_URL_HOST, OST_ADMIN_USER, OST_ADMIN_PASS, OST_ADMIN_EMAIL,
 * OST_SYSTEM_EMAIL, OST_TIMEZONE.
 */
$root = rtrim($argv[1] ?? '', '/');
if (!$root || !is_dir("$root/setup"))
    fwrite(STDERR, "Uso: php osticket-install.php <dir-osticket>\n") && exit(1);

$env = fn($k, $d) => getenv($k) !== false ? getenv($k) : $d;

// L'installer si aspetta un contesto HTTP.
$_SERVER['HTTP_HOST'] = $env('OST_URL_HOST', 'localhost:8080');
$_SERVER['PHP_SELF'] = '/setup/install.php';
$_SERVER['SCRIPT_NAME'] = '/setup/install.php';
$_SERVER['REQUEST_URI'] = '/setup/install.php';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['REQUEST_METHOD'] = 'POST';

chdir("$root/setup");
require 'setup.inc.php';
require_once INC_DIR.'class.installer.php';

$installer = new Installer("$root/include/ost-config.php");
$vars = [
    'name' => 'Helpdesk DEV',
    'email' => $env('OST_SYSTEM_EMAIL', 'support@example.com'),
    'lang_id' => 'en_US',
    'fname' => 'Admin',
    'lname' => 'Dev',
    'admin_email' => $env('OST_ADMIN_EMAIL', 'admin@example.com'),
    'username' => $env('OST_ADMIN_USER', 'devadmin'),
    'passwd' => $env('OST_ADMIN_PASS', 'Passw0rd!dev'),
    'passwd2' => $env('OST_ADMIN_PASS', 'Passw0rd!dev'),
    'prefix' => $env('OST_PREFIX', 'ost_'),
    'dbhost' => $env('OST_DB_HOST', 'localhost'),
    'dbname' => $env('OST_DB_NAME', 'osticket'),
    'dbuser' => $env('OST_DB_USER', 'osticket'),
    'dbpass' => $env('OST_DB_PASS', 'osticket'),
    'timezone' => $env('OST_TIMEZONE', 'Europe/Rome'),
];

if ($installer->install($vars)) {
    echo "osTicket installato.\n";
    exit(0);
}
fwrite(STDERR, "Installazione fallita:\n".print_r($installer->getErrors(), true));
exit(1);
