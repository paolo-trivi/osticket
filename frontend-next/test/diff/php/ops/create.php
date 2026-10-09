<?php
/**
 * Operazioni PHP dell'area "create" (apertura ticket da agente e dal portale, upload allegati)
 * per l'harness differenziale. Riproducono scp/tickets.php (a=open), open.php e
 * l'upload AJAX di FileUploadField::ajaxUpload con il codice originale di osTicket.
 */

if (!function_exists('create_uploaded')) {
    /** File caricati "in questa sessione" ($_SESSION[':uploadedFiles']) e richiesta POST. */
    function create_uploaded(array $op) {
        $_SERVER['REQUEST_METHOD'] = 'POST';
        foreach (($op['args']['uploaded'] ?? []) as $id => $name)
            $_SESSION[':uploadedFiles'][$id] = $name;
    }
}

// FileUploadField::ajaxUpload → AttachmentFile::upload (senza is_uploaded_file, impossibile da CLI)
$OPS['create.upload'] = function (array $op) {
    $a = $op['args'];
    $tmp = tempnam(sys_get_temp_dir(), 'ostup');
    file_put_contents($tmp, base64_decode($a['data']));
    $name = Format::sanitize(urldecode($a['name']));
    list($key, $sig) = AttachmentFile::_getKeyAndHash($tmp, true);
    $info = array(
        'type' => $a['type'],
        'filetype' => 'T',
        'size' => filesize($tmp),
        'name' => $name,
        'key' => $key,
        'signature' => $sig,
        'tmp_name' => $tmp,
    );
    $F = AttachmentFile::create($info, 'T', true);
    @unlink($tmp);
    return ['ok' => (bool) $F, 'id' => $F ? $F->getId() : null];
};

// scp/tickets.php a=open → Ticket::open
$OPS['ticket.open'] = function (array $op) {
    global $thisstaff;
    $thisstaff = Staff::lookup($op['args']['agent']);
    $GLOBALS['thisstaff'] = $thisstaff;
    create_uploaded($op);
    $vars = $op['args']['vars'];
    $errors = array();
    if (!$thisstaff->hasPerm(Ticket::PERM_CREATE, false))
        return ['ok' => false, 'errors' => ['err' => 'perm']];
    if (!empty($vars['uid']) && !User::lookup($vars['uid']))
        $vars['uid'] = 0;
    // allegati della risposta iniziale (campo attachments del form di risposta)
    $vars['files'] = $op['args']['responseFiles'] ?? array();
    $ticket = Ticket::open($vars, $errors);
    if ($ticket)
        Draft::deleteForNamespace('ticket.staff%', $thisstaff->getId());
    return [
        'ok' => (bool) $ticket,
        'id' => $ticket ? $ticket->getId() : null,
        'number' => $ticket ? $ticket->getNumber() : null,
        'errors' => $errors,
    ];
};

// open.php (portale clienti) → Ticket::create($vars, $errors, 'Web')
$OPS['ticket.create.web'] = function (array $op) {
    global $thisclient;
    create_uploaded($op);
    $vars = $op['args']['vars'];
    $vars['deptId'] = $vars['emailId'] = 0;
    if (!empty($op['args']['client'])) {
        $thisclient = new EndUser(User::lookup($op['args']['client']));
        $GLOBALS['thisclient'] = $thisclient;
        $vars['uid'] = $thisclient->getId();
    }
    $errors = array();
    $tform = TicketForm::objects()->one()->getForm($vars);
    $messageField = $tform->getField('message');
    $attachments = $messageField->getWidget()->getAttachments();
    $vars['message'] = $messageField->getClean();
    if ($messageField->isAttachmentsEnabled())
        $vars['files'] = $attachments->getFiles();
    $ticket = Ticket::create($vars, $errors, 'Web');
    return [
        'ok' => (bool) $ticket,
        'id' => $ticket ? $ticket->getId() : null,
        'number' => $ticket ? $ticket->getNumber() : null,
        'errors' => $errors,
    ];
};
