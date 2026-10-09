<?php
// Operazioni "core" del coordinatore: variabili di template condivise.

// FormattedDate (class.format.php): %{…create_date.short|long|time|full} e asVar
$OPS['core.formatdate'] = function (array $op) {
    $d = new FormattedDate($op['args']['date']);
    $out = ['asVar' => (string) $d->asVar()];
    foreach (['short', 'long', 'time', 'full'] as $k)
        $out[$k] = (string) $d->getVar($k);
    return $out;
};
