<?php
/**
 * Installazione non interattiva di osTicket con lo stesso codice dell'installer web
 * (setup/inc/class.installer.php), per il primo avvio dello stack TailTicket.
 * Uso: php install.php <dir-osticket> <file-config-temporaneo>
 */
[$_, $root, $tmpConfig] = $argv + [null, null, null];
$root = rtrim((string) $root, '/');
if (!$root || !is_dir("$root/setup") || !$tmpConfig) { fwrite(STDERR, "Uso: php install.php <dir-osticket> <config-temp>\n"); exit(1); }
$env = fn($k, $d) => (getenv($k) !== false && getenv($k) !== '') ? getenv($k) : $d;

// SECRET_SALT condiviso con TailTicket (Message-ID firmati, segreti cifrati): definito prima dell'installer
define('SECRET_SALT', $env('OST_SECRET_SALT', ''));
if (strlen(SECRET_SALT) < 32) { fwrite(STDERR, "OST_SECRET_SALT mancante o troppo corto\n"); exit(1); }

// L'installer ricava helpdesk_url dalla richiesta HTTP: la simuliamo all'URL pubblico del pannello classico
$url = parse_url($env('TAILTICKET_URL', 'http://localhost'));
$_SERVER['HTTP_HOST'] = $url['host'].(isset($url['port']) ? ':'.$url['port'] : '');
if (($url['scheme'] ?? 'http') === 'https') $_SERVER['HTTPS'] = 'on';
$_SERVER['PHP_SELF'] = $_SERVER['SCRIPT_NAME'] = $_SERVER['REQUEST_URI'] = '/classic/setup/install.php';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['REQUEST_METHOD'] = 'POST';

copy("$root/include/ost-sampleconfig.php", $tmpConfig);
chdir("$root/setup");
require 'setup.inc.php';
require_once INC_DIR.'class.installer.php';

$installer = new Installer($tmpConfig);
$pass = $env('TAILTICKET_ADMIN_PASSWORD', '');
$vars = [
    'name' => $env('TAILTICKET_HELPDESK_NAME', 'TailTicket'),
    'email' => $env('TAILTICKET_SYSTEM_EMAIL', 'support@example.com'),
    'lang_id' => 'en_US',
    'fname' => $env('TAILTICKET_ADMIN_FIRSTNAME', 'Admin'),
    'lname' => $env('TAILTICKET_ADMIN_LASTNAME', 'TailTicket'),
    'admin_email' => $env('TAILTICKET_ADMIN_EMAIL', 'admin@example.com'),
    'username' => $env('TAILTICKET_ADMIN_USER', 'ttadmin'),
    'passwd' => $pass,
    'passwd2' => $pass,
    'prefix' => $env('OST_TABLE_PREFIX', 'ost_'),
    'dbhost' => $env('OST_DB_HOST', 'db').':'.$env('OST_DB_PORT', '3306'),
    'dbname' => $env('OST_DB_NAME', 'osticket'),
    'dbuser' => $env('OST_DB_USER', 'osticket'),
    'dbpass' => $env('OST_DB_PASS', ''),
    'timezone' => $env('TAILTICKET_TIMEZONE', 'Europe/Rome'),
];
if ($installer->install($vars)) {
    // La password iniziale sta in chiaro in .env ed è stampata da "./tailticket up": si impone il cambio al
    // primo accesso (Staff::setPassword dell'installer azzera change_passwd). Vale per TailTicket e per scp/.
    $admin = Staff::lookup(['username' => $vars['username']]);
    if ($admin) { $admin->change_passwd = 1; $admin->save(); }
    echo "osTicket installato\n";
    exit(0);
}
fwrite(STDERR, "Installazione di osTicket fallita:\n".print_r($installer->getErrors(), true));
exit(1);
