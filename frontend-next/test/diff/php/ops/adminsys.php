<?php
/**
 * Operazioni PHP dell'area "adminsys" (amministrazione: email, filtri, form, liste, pagine, code,
 * API key, log, plugin). Ogni operazione riproduce il ramo POST della relativa pagina scp/*.php
 * chiamando le classi originali di osTicket.
 */

/** Agente corrente (admin) per le operazioni che lo richiedono. */
function adminsys_staff(array $op) {
    $staff = Staff::lookup($op['args']['agent'] ?? 1);
    $GLOBALS['thisstaff'] = $staff;
    return $staff;
}

/** Normalizza gli errori (array annidati o oggetti) per il JSON del risultato. */
function adminsys_errors($errors) {
    $out = array();
    foreach ((array) $errors as $k => $v)
        $out[$k] = is_scalar($v) ? (string) $v : json_encode($v);
    return $out;
}

// ---------------------------------------------------------------- Email (scp/emails.php)
$OPS['email.save'] = function (array $op) {
    global $cfg;
    adminsys_staff($op);
    $vars = $op['args']['vars'];
    $errors = array();
    if (!empty($op['args']['id'])) {
        $email = Email::lookup($op['args']['id']);
        $vars['id'] = $email->getId();
        $ok = $email->update($vars, $errors);
    } else {
        $email = Email::create();
        $ok = $email->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $email->getId() : null, 'errors' => adminsys_errors($errors)];
};

$OPS['email.delete'] = function (array $op) {
    global $cfg;
    adminsys_staff($op);
    $i = 0;
    foreach ($op['args']['ids'] as $v) {
        if ($v != $cfg->getDefaultEmailId() && ($e = Email::lookup($v)) && $e->delete())
            $i++;
    }
    return ['ok' => true, 'deleted' => $i];
};

// Configurazione autenticazione basic di un account (ajax.php/email/<id>/auth/config/<type>/basic)
$OPS['email.auth'] = function (array $op) {
    adminsys_staff($op);
    $email = Email::lookup($op['args']['id']);
    // dati del form "stashati" in sessione dal pannello (host/porta/protocollo correnti)
    if (!empty($op['args']['stash']))
        $email->stashFormData($op['args']['stash']);
    $account = $email->getAuthAccount($op['args']['type']);
    $_POST = $op['args']['vars'];
    $_SERVER['REQUEST_METHOD'] = 'POST';
    $form = $account->getAuthConfigForm($op['args']['auth'], $_POST);
    $errors = array();
    $ok = $account->saveAuth($op['args']['auth'], $form, $errors);
    return ['ok' => (bool) $ok, 'errors' => adminsys_errors($errors), 'formErrors' => adminsys_errors($form->errors())];
};
