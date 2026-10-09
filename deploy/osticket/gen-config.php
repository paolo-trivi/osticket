<?php
/**
 * Genera include/ost-config.php di osTicket dalle variabili d'ambiente, partendo da ost-sampleconfig.php
 * (stesso formato dell'installer). Uso: php gen-config.php <sample> <destinazione>
 */
[$_, $sample, $dest] = $argv + [null, null, null];
$env = function ($k, $d = null) {
    $v = getenv($k);
    if ($v === false || $v === '') {
        if ($d === null) { fwrite(STDERR, "Variabile d'ambiente mancante: $k\n"); exit(2); }
        return $d;
    }
    return $v;
};
$q = fn($v) => var_export((string) $v, true);   // stringa PHP con apici e escape corretti

$src = file_get_contents($sample);
$map = [
    "define('OSTINSTALLED',FALSE);" => "define('OSTINSTALLED',TRUE);",
    "'%CONFIG-SIRI'" => $q($env('OST_SECRET_SALT')),
    "'%ADMIN-EMAIL'" => $q($env('OST_ADMIN_EMAIL', 'admin@example.com')),
    "'%CONFIG-DBHOST'" => $q($env('OST_DB_HOST', 'db').':'.$env('OST_DB_PORT', '3306')),
    "'%CONFIG-DBNAME'" => $q($env('OST_DB_NAME', 'osticket')),
    "'%CONFIG-DBUSER'" => $q($env('OST_DB_USER', 'osticket')),
    "'%CONFIG-DBPASS'" => $q($env('OST_DB_PASS')),
    "'%CONFIG-PREFIX'" => $q($env('OST_TABLE_PREFIX', 'ost_')),
    // reverse proxy sulla rete interna di Docker: osTicket può fidarsi di X-Forwarded-For
    "define('TRUSTED_PROXIES', '');" => "define('TRUSTED_PROXIES', ".$q($env('OST_TRUSTED_PROXIES', '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16')).");",
];
foreach ($map as $from => $to) {
    if (strpos($src, $from) === false) { fwrite(STDERR, "Segnaposto non trovato in $sample: $from\n"); exit(3); }
    $src = str_replace($from, $to, $src);
}
file_put_contents($dest, $src);
echo "ost-config.php generato\n";
