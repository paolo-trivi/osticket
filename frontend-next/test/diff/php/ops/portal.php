<?php
/**
 * Operazioni PHP dell'area "portal" (portale clienti, M4) per l'harness differenziale.
 * Riproducono il codice delle pagine della root (login.php, view.php, account.php, pwreset.php,
 * profile.php, tickets.php, open.php) con le classi originali di osTicket. L'utente corrente
 * è in $GLOBALS['thisclient'] come in client.inc.php.
 */

if (!function_exists('portal_client')) {
    /** $thisclient come lo costruisce client.inc.php (EndUser dell'utente; guest se richiesto) */
    function portal_client(array $a) {
        global $thisclient;
        $thisclient = null;
        if (!empty($a['client'])) {
            $thisclient = new EndUser(User::lookup($a['client']));
            if (!empty($a['guestTicket'])) {
                // Accesso da link: ClientSession(TicketOwner) marcato come ospite
                $T = Ticket::lookup($a['guestTicket']);
                if ($T && $T->getOwnerId() == $a['client'])
                    $thisclient = new ClientSession($T->getOwner());
                else
                    $thisclient = new ClientSession(Collaborator::lookup(array(
                        'user_id' => $a['client'], 'thread__ticket__ticket_id' => $a['guestTicket'])));
                $thisclient->flagGuest();
            }
        }
        $GLOBALS['thisclient'] = $thisclient;
        return $thisclient;
    }

    function portal_session_user() {
        $s = $_SESSION['_auth']['user'] ?? array();
        return array('id' => $s['id'] ?? null, 'key' => $s['key'] ?? null);
    }
}

// login.php (POST luser/lpasswd), ripetuto `attempts` volte nella stessa sessione (strike)
$OPS['portal.login'] = function (array $op) {
    global $cfg;
    $a = $op['args'];
    $out = array();
    for ($i = 0; $i < ($a['attempts'] ?? 1); $i++) {
        $errors = array();
        $luser = trim($a['login']);
        $ok = false;
        if (!$luser)
            $errors['err'] = 'required';
        elseif (Validator::is_userid($luser, $errors['err'], false)
                && ($user = UserAuthenticationBackend::process($luser,
                    substr($a['password'], 0, 128), $errors))) {
            $ok = !($user instanceof ClientCreateRequest);
        }
        $out[] = array('ok' => $ok, 'err' => $errors['err'] ?? null);
    }
    return ['ok' => true, 'results' => $out, 'session' => portal_session_user()];
};

// login.php (POST lemail/lticket): link di accesso via email, o accesso diretto senza verifica
$OPS['portal.accesslink'] = function (array $op) {
    global $cfg;
    $a = $op['args'];
    $out = array();
    for ($i = 0; $i < ($a['attempts'] ?? 1); $i++) {
        $errors = array();
        $res = array('ok' => false, 'sent' => false, 'login' => false);
        if (!Validator::is_email($a['email']))
            $errors['err'] = 'invalid_email';
        elseif (($user = UserAuthenticationBackend::process($a['email'], $a['number'], $errors))) {
            if (!$cfg->isClientEmailVerificationRequired())
                $res = array('ok' => true, 'sent' => false, 'login' => true);
            else {
                $ticket = Ticket::lookupByNumber($a['number'], $a['email']);
                if ($ticket) {
                    $ticket->sendAccessLink($user);
                    $res = array('ok' => true, 'sent' => true, 'login' => false);
                }
            }
        }
        $res['err'] = $errors['err'] ?? null;
        $out[] = $res;
    }
    return ['ok' => true, 'results' => $out, 'session' => portal_session_user()];
};

// view.php?auth=<token>: AuthTokenAuthentication::signOn tramite processSignOn
$OPS['portal.token'] = function (array $op) {
    $_GET['auth'] = $op['args']['auth'];
    $errors = array();
    $user = UserAuthenticationBackend::processSignOn($errors, false);
    return [
        'ok' => (bool) $user,
        'userId' => $user ? $user->getId() : null,
        'ticketId' => $user ? $user->getTicketId() : null,
        'err' => $errors['err'] ?? null,
        'session' => portal_session_user(),
    ];
};

// account.php POST do=create (registrazione di un nuovo account, visitatore non autenticato)
$OPS['portal.register'] = function (array $op) {
    global $cfg, $ost;
    $thisclient = portal_client($op['args']);
    // Company legge i propri campi (name, phone, …) da $_POST al primo accesso durante una POST: il
    // nome inviato dal visitatore finirebbe come %{company.name} nell'email di conferma (contenuto
    // falsificabile verso indirizzi arbitrari, non replicato in Next). Si carica prima di $_POST.
    $ost->company->getInfo();
    $_POST = $op['args']['vars'];
    $errors = array();
    $user = null;
    if (!$cfg || !$cfg->isClientRegistrationEnabled())
        return ['ok' => false, 'errors' => ['err' => 'disabled']];

    $user_form = UserForm::getUserForm()->getForm($_POST);
    if ($thisclient) {
        $user_form->getField('email')->configure('disabled', true);
        $user_form->getField('email')->value = $thisclient->getEmail();
        $_POST['email'] = $thisclient->getEmail();
    }

    if (!$user_form->isValid(function($f) { return $f->isVisibleToUsers(); }))
        $errors['err'] = __('Incomplete client information');
    elseif (!$_POST['backend'] && !$_POST['passwd1'])
        $errors['passwd1'] = __('New password is required');
    elseif (!$_POST['backend'] && $_POST['passwd2'] != $_POST['passwd1'])
        $errors['passwd1'] = __('Passwords do not match');
    else {
        try {
            UserAccount::checkPassword($_POST['passwd1']);
        } catch (BadPassword $ex) {
             $errors['passwd1'] = $ex->getMessage();
        }
    }

    if ($errors)
        $errors['err'] = $errors['err'] ?: __('Unable to register account. See messages below');
    elseif (($addr = $user_form->getField('email')->getClean())
            && ClientAccount::lookupByUsername($addr)) {
        $errors['email'] = 'registered';
        $errors['err'] = __('Unable to register account. See messages below');
    }
    elseif (!$addr)
        $errors['email'] = 'required';
    elseif (!$user_form->getField('name')->getClean())
        $errors['name'] = 'required';
    elseif ($addr && ($user = User::lookupByEmail($addr)) && !$user->updateInfo($_POST, $errors))
      $errors['err'] = __('Unable to register account. See messages below');
    elseif (!$user && !($user = $thisclient ?: User::fromForm($user_form)))
        $errors['err'] = __('Unable to register account. See messages below');
    else {
        if (!($acct = ClientAccount::createForUser($user)))
            $errors['err'] = 'internal';
        elseif (!$acct->update($_POST, $errors))
            $errors['err'] = __('Errors configuring your profile. See messages below');
    }

    if (!$errors && $_POST['do'] == 'create')
        $acct->sendConfirmEmail();

    if ($errors && $user && $user != $thisclient)
        $user->delete();

    return ['ok' => !$errors, 'errors' => $errors, 'userId' => $user ? $user->getId() : null];
};

// pwreset.php?token=<token> (GET): conferma dell'account e accesso
$OPS['portal.confirm'] = function (array $op) {
    $token = $op['args']['token'];
    $_GET['token'] = $token;
    $errors = array();
    $res = array('ok' => false, 'confirmed' => false, 'login' => false);
    $_config = new Config('pwreset');
    if (($id = $_config->get($token))
            && ($acct = ClientAccount::lookup(array('user_id'=>substr($id,1))))) {
        if (!$acct->isConfirmed()) {
            $acct->confirm();
            ModelInstanceManager::uncache($acct);
            $res['confirmed'] = true;
            if ($client = UserAuthenticationBackend::processSignOn($errors)) {
                if ($acct->hasPassword() && !$acct->get('backend')) {
                    $acct->cancelResetTokens();
                }
                else {
                    $_SESSION['_client']['reset-token'] = $token;
                    $acct->forcePasswdReset();
                }
                $res['login'] = true;
            }
        } else
            $res['form'] = true;
        $res['ok'] = true;
    }
    $res['err'] = $errors['err'] ?? null;
    $res['session'] = portal_session_user();
    return $res;
};

// pwreset.php POST do=sendmail
$OPS['portal.pwreset.send'] = function (array $op) {
    $userid = (string) $op['args']['userid'];
    $res = 'sent';
    if (Validator::is_userid($userid)
            && ($acct=ClientAccount::lookupByUsername($userid))) {
        if (!$acct->isPasswdResetEnabled())
            $res = 'disabled';
        elseif (!$acct->hasPassword()
                || (($bk=$acct->backend) && ($bk !== 'client')))
            $res = 'unavailable';
        elseif (!$acct->sendResetEmail())
            $res = 'failed';
    }
    return ['ok' => true, 'result' => $res];
};

// pwreset.php POST do=reset (userid + token): ClientPasswordResetTokenBackend
$OPS['portal.pwreset.login'] = function (array $op) {
    $_POST['userid'] = $op['args']['userid'];
    $_POST['token'] = $op['args']['token'];
    $_SERVER['REQUEST_METHOD'] = 'POST';
    $errors = array();
    $client = UserAuthenticationBackend::processSignOn($errors);
    return [
        'ok' => (bool) $client,
        'err' => $errors['err'] ?? null,
        'resetToken' => $_SESSION['_client']['reset-token'] ?? null,
        'session' => portal_session_user(),
    ];
};

// profile.php POST: ClientAccount::update + User::updateInfo (campi modificabili dai clienti)
$OPS['portal.profile'] = function (array $op) {
    $a = $op['args'];
    $thisclient = portal_client($a);
    if (!empty($a['resetToken']))
        $_SESSION['_client']['reset-token'] = $a['resetToken'];
    $_POST = $a['vars'];
    $user = User::lookup($thisclient->getId());
    $errors = array();
    if ($acct = $thisclient->getAccount())
       $acct->update($_POST, $errors);
    $ok = false;
    if (!$errors && $user->updateInfo($_POST, $errors))
        $ok = true;
    return ['ok' => $ok, 'errors' => $errors];
};

// tickets.php POST a=reply: Ticket::postMessage dal portale
$OPS['portal.message'] = function (array $op) {
    $a = $op['args'];
    $thisclient = portal_client($a);
    $_SERVER['REQUEST_METHOD'] = 'POST';
    foreach (($a['uploaded'] ?? []) as $id => $name)
        $_SESSION[':uploadedFiles'][$id] = $name;
    $ticket = Ticket::lookup($a['ticket']);
    if (!$ticket || !$ticket->checkUserAccess($thisclient))
        return ['ok' => false, 'error' => 'access'];
    $tform = TicketForm::objects()->one()->getForm();
    $messageField = $tform->getField('message');
    $attachments = $messageField->getWidget()->getAttachments();
    $message = ThreadEntryBody::clean($a['message']);
    if (!$message)
        return ['ok' => false, 'error' => 'message'];
    $vars = array(
        'userId' => $thisclient->getId(),
        'poster' => (string) $thisclient->getName(),
        'message' => $message,
    );
    $vars['files'] = $a['files'] ?? array();
    if (($msg = $ticket->postMessage($vars, 'Web'))) {
        Draft::deleteForNamespace('ticket.client.' . $ticket->getId());
        return ['ok' => true, 'id' => $msg->getId()];
    }
    return ['ok' => false, 'error' => 'post'];
};

// tickets.php POST a=edit: campi del ticket modificabili dal proprietario
$OPS['portal.edit'] = function (array $op) {
    $a = $op['args'];
    $thisclient = portal_client($a);
    $ticket = Ticket::lookup($a['ticket']);
    $errors = array();
    if (!$ticket->checkUserAccess($thisclient) || $thisclient->getId() != $ticket->getUserId())
        return ['ok' => false, 'errors' => ['err' => 'access']];
    $forms = DynamicFormEntry::forTicket($ticket->getId());
    $changes = array();
    foreach ($forms as $form) {
        $form->filterFields(function($f) { return !$f->isStorable(); });
        $form->setSource($a['vars']);
        if (!$form->isValidForClient(true))
            $errors = array_merge($errors, $form->errors());
    }
    if ($errors)
        return ['ok' => false, 'errors' => $errors];
    foreach ($forms as $form) {
        $changes += $form->getChanges();
        $form->saveAnswers(function ($f) {
                return $f->isVisibleToUsers()
                 && $f->isEditableToUsers(); });
    }
    if ($changes) {
      $user = User::lookup($thisclient->getId());
      $ticket->logEvent('edited', array('fields' => $changes), $user);
    }
    return ['ok' => true, 'changes' => count($changes)];
};

// open.php POST: Ticket::create($vars, $errors, 'Web') con pulizia delle bozze della sessione
$OPS['portal.open'] = function (array $op) {
    global $cfg;
    $a = $op['args'];
    $thisclient = portal_client($a);
    $_SERVER['REQUEST_METHOD'] = 'POST';
    foreach (($a['uploaded'] ?? []) as $id => $name)
        $_SESSION[':uploadedFiles'][$id] = $name;
    $vars = $a['vars'];
    $vars['deptId'] = $vars['emailId'] = 0;
    if ($thisclient)
        $vars['uid'] = $thisclient->getId();
    $errors = array();
    $tform = TicketForm::objects()->one()->getForm($vars);
    $messageField = $tform->getField('message');
    $attachments = $messageField->getWidget()->getAttachments();
    $vars['message'] = $messageField->getClean();
    if ($messageField->isAttachmentsEnabled())
        $vars['files'] = $attachments->getFiles();
    Draft::deleteForNamespace('ticket.client.'.substr($a['session'], -12));
    $ticket = Ticket::create($vars, $errors, 'Web');
    return [
        'ok' => (bool) $ticket,
        'id' => $ticket ? $ticket->getId() : null,
        'number' => $ticket ? $ticket->getNumber() : null,
        'errors' => $errors,
    ];
};
