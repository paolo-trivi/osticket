<?php
/**
 * Operazioni PHP dell'area "people" (task, utenti/organizzazioni, profilo agente) per l'harness
 * differenziale. Ogni closure riproduce il percorso di scp/*.php / include/ajax.*.php con il codice
 * originale di osTicket.
 */

require_once INCLUDE_DIR.'class.note.php';

if (!function_exists('people_staff')) {
    function people_staff(array $op) {
        $s = Staff::lookup($op['args']['agent']);
        $GLOBALS['thisstaff'] = $s;
        return $s;
    }
    function people_task(array $op) {
        $t = Task::lookup($op['args']['task']);
        if (!$t) throw new Exception('task mancante');
        return $t;
    }
}

/* ============================== TASK ============================== */

// ajax.tasks.php:add / ajax.tickets.php:addTask
$OPS['task.create'] = function (array $op) {
    global $thisstaff;
    $thisstaff = people_staff($op);
    $a = $op['args'];
    $form = TaskForm::getInstance();
    $form->setSource(['title' => $a['title'], 'description' => $a['description'] ?? '']);
    $iform = TaskForm::getInternalForm([
        'dept_id' => $a['deptId'],
        'assignee' => $a['assignee'] ?? '',
        'duedate' => $a['duedate'] ?? '',
    ]);
    $ok = $iform->isValid() & $form->isValid();
    if (!$ok)
        return ['ok' => false, 'errors' => [$iform->errors(), $form->errors()]];
    $vars = [];
    if (!empty($a['ticket'])) {
        $vars['object_id'] = $a['ticket'];
        $vars['object_type'] = ObjectModel::OBJECT_TYPE_TICKET;
    }
    $vars['default_formdata'] = $form->getClean();
    $vars['internal_formdata'] = $iform->getClean();
    $vars['description'] = $form->getField('description')->getClean();
    $vars['staffId'] = $thisstaff->getId();
    $vars['poster'] = $thisstaff;
    $vars['ip_address'] = $_SERVER['REMOTE_ADDR'];
    $errors = [];
    $task = Task::create($vars, $errors);
    return ['ok' => (bool) $task, 'id' => $task ? $task->getId() : null, 'number' => $task ? $task->getNumber() : null];
};

// scp/tasks.php a=postnote
$OPS['task.note'] = function (array $op) {
    $staff = people_staff($op);
    $task = people_task($op);
    $vars = ['note' => $op['args']['note'], 'title' => $op['args']['title'] ?? ''];
    if (isset($op['args']['status'])) $vars['task:status'] = $op['args']['status'];
    $errors = [];
    $note = $task->postNote($vars, $errors, $staff);
    return ['ok' => (bool) $note, 'id' => $note ? $note->getId() : null, 'errors' => $errors];
};

// scp/tasks.php a=postreply
$OPS['task.reply'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $vars = ['response' => $op['args']['response']];
    if (isset($op['args']['status'])) $vars['task:status'] = $op['args']['status'];
    $errors = [];
    $r = $task->postReply($vars, $errors);
    return ['ok' => (bool) $r, 'id' => $r ? $r->getId() : null, 'errors' => $errors];
};

// ajax.tasks.php:assign
$OPS['task.assign'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $form = $task->getAssignmentForm(
        ['assignee' => [$op['args']['assignee']], 'comments' => $op['args']['comments'] ?? ''],
        ['target' => $op['args']['target'] ?? null]);
    if (!$form->isValid()) return ['ok' => false, 'errors' => $form->errors()];
    $errors = [];
    $ok = $task->assign($form, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:claim
$OPS['task.claim'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $form = $task->getClaimForm(['assignee' => ['s'.$op['args']['agent']], 'comments' => $op['args']['comments'] ?? '']);
    if (!$form->isValid()) return ['ok' => false, 'errors' => $form->errors()];
    $errors = [];
    $ok = $task->claim($form, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:transfer
$OPS['task.transfer'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $form = $task->getTransferForm(['dept' => [$op['args']['dept']], 'comments' => $op['args']['comments'] ?? '']);
    if (!$form->isValid()) return ['ok' => false, 'errors' => $form->errors()];
    $errors = [];
    $ok = $task->transfer($form, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:changeStatus
$OPS['task.status'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $errors = [];
    $ok = $task->setStatus($op['args']['status'], $op['args']['comments'] ?? '', $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:edit (Task::update)
$OPS['task.edit'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $forms = DynamicFormEntry::forObject($task->getId(), ObjectModel::OBJECT_TYPE_TASK);
    $vars = $op['args']['fields'];
    if (isset($op['args']['note'])) $vars['note'] = $op['args']['note'];
    $errors = [];
    $ok = $task->update($forms, $vars, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:editField (solo duedate)
$OPS['task.duedate'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $field = $task->getField('duedate');
    $form = $field->getEditForm(['duedate' => $op['args']['duedate'], 'comments' => $op['args']['comments'] ?? '']);
    if (!$form->isValid()) return ['ok' => false, 'errors' => $form->errors()];
    $errors = [];
    $ok = $task->updateField($form, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:delete
$OPS['task.delete'] = function (array $op) {
    people_staff($op);
    $task = people_task($op);
    $errors = [];
    $ok = $task->delete(['comments' => $op['args']['comments'] ?? ''], $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.tasks.php:massProcess
$OPS['task.mass'] = function (array $op) {
    global $thisstaff;
    $thisstaff = people_staff($op);
    $a = $op['args'];
    $i = 0;
    $e = [];
    foreach ($a['tids'] as $tid) {
        if (!($t = Task::lookup($tid))) continue;
        switch ($a['action']) {
        case 'claim':
            $form = ClaimForm::instantiate(['assignee' => ['s'.$thisstaff->getId()]]);
            $form->setAssignees(['s'.$thisstaff->getId() => $thisstaff->getName()]);
            if ($form->isValid() && $t->checkStaffPerm($thisstaff, Task::PERM_ASSIGN) && $t->claim($form, $e)) $i++;
            break;
        case 'assign':
            $form = AssignmentForm::instantiate(['assignee' => [$a['assignee']]]);
            if ($form->isValid() && $t->checkStaffPerm($thisstaff, Task::PERM_ASSIGN) && $t->assign($form, $e)) $i++;
            break;
        case 'transfer':
            $form = TransferForm::instantiate(['dept' => [$a['dept']]]);
            if ($form->isValid() && $t->checkStaffPerm($thisstaff, Task::PERM_TRANSFER) && $t->transfer($form, $e)) $i++;
            break;
        case 'close':
        case 'reopen':
            $perm = $a['action'] == 'close' ? Task::PERM_CLOSE : Task::PERM_CREATE;
            if ($thisstaff->hasPerm($perm, false) && $t->checkStaffPerm($thisstaff, $perm)
                && $t->setStatus($a['action'] == 'close' ? 'closed' : 'open', $a['comments'] ?? ''))
                $i++;
            break;
        case 'delete':
            if ($t->checkStaffPerm($thisstaff, Task::PERM_DELETE) && $t->delete(['comments' => $a['comments'] ?? ''], $e)) $i++;
            break;
        }
    }
    return ['ok' => $i > 0, 'count' => $i];
};

/* ======================= UTENTI E ORGANIZZAZIONI ======================= */

if (!function_exists('people_user')) {
    function people_user(array $op) {
        $u = User::lookup($op['args']['user']);
        if (!$u) throw new Exception('utente mancante');
        return $u;
    }
    function people_org(array $op) {
        $o = Organization::lookup($op['args']['org']);
        if (!$o) throw new Exception('organizzazione mancante');
        return $o;
    }
}

// scp/users.php do=create
$OPS['user.create'] = function (array $op) {
    people_staff($op);
    $form = UserForm::getUserForm()->getForm($op['args']['fields']);
    $user = User::fromForm($form);
    return ['ok' => (bool) $user, 'id' => $user ? $user->getId() : null, 'errors' => $user ? [] : $form->errors()];
};

// ajax.users.php:updateUser
$OPS['user.update'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    $errors = [];
    $ok = $user->updateInfo($op['args']['fields'], $errors, true);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.users.php:manage (account esistente)
$OPS['user.account.update'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    $errors = [];
    $ok = $user->getAccount()->update($op['args']['vars'], $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.users.php:register
$OPS['user.register'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    $errors = [];
    $ok = $user->register($op['args']['vars'], $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.users.php:delete
$OPS['user.delete'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    if ($user->tickets->count()) {
        if (empty($op['args']['deletetickets'])) return ['ok' => false, 'error' => 'tickets'];
        if (!$user->deleteAllTickets()) return ['ok' => false, 'error' => 'perm'];
    }
    return ['ok' => (bool) $user->delete()];
};

// ajax.users.php:updateOrg (organizzazione esistente)
$OPS['user.setorg'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    $org = Organization::lookup($op['args']['orgId']);
    return ['ok' => (bool) ($org && $user->setOrganization($org))];
};

// scp/users.php do=confirmlink / pwreset
$OPS['user.sendmail'] = function (array $op) {
    people_staff($op);
    $user = people_user($op);
    $acct = $user->getAccount();
    $ok = $op['args']['kind'] == 'confirm' ? $acct->sendConfirmEmail() : $acct->sendResetEmail();
    return ['ok' => (bool) $ok];
};

// scp/users.php do=mass_process
$OPS['user.mass'] = function (array $op) {
    people_staff($op);
    $a = $op['args'];
    $users = User::objects()->filter(['id__in' => $a['ids']]);
    $count = 0;
    $errors = [];
    foreach ($users as $U) {
        switch ($a['action']) {
        case 'lock':
            if (($acct = $U->getAccount()) && $acct->lock()) $count++;
            break;
        case 'unlock':
            if (($acct = $U->getAccount()) && $acct->unlock()) $count++;
            break;
        case 'delete':
            if (!empty($a['deletetickets'])) $U->deleteAllTickets();
            if ($U->delete()) $count++;
            break;
        case 'reset':
            if (($acct = $U->getAccount()) && $acct->sendResetEmail()) $count++;
            break;
        case 'register':
            if (($acct = $U->getAccount()) && $acct->sendConfirmEmail()) $count++;
            elseif (UserAccount::register($U, ['sendemail' => true], $errors)) $count++;
            break;
        case 'setorg':
            if (($org = Organization::lookup($a['orgId'])) && $U->setOrganization($org)) $count++;
            break;
        }
    }
    return ['ok' => $count > 0, 'count' => $count];
};

// ajax.users.php:importUsers / ajax.orgs.php:importUsers
$OPS['user.import'] = function (array $op) {
    people_staff($op);
    $extra = isset($op['args']['orgId']) ? ['org_id' => $op['args']['orgId']] : [];
    $status = User::importFromPost($op['args']['pasted'], $extra);
    return ['ok' => is_numeric($status), 'status' => $status];
};

// ajax.note.php
$OPS['note.create'] = function (array $op) {
    global $thisstaff;
    $thisstaff = people_staff($op);
    $note = new QuickNote([
        'staff_id' => $thisstaff->getId(),
        'body' => Format::sanitize($op['args']['note']),
        'created' => new SqlFunction('NOW'),
        'ext_id' => $op['args']['ext'],
    ]);
    $ok = $note->save(true);
    return ['ok' => (bool) $ok, 'id' => $note->id];
};
$OPS['note.update'] = function (array $op) {
    people_staff($op);
    $note = QuickNote::lookup($op['args']['id']);
    $note->body = Format::sanitize($op['args']['note']);
    return ['ok' => (bool) $note->save()];
};
$OPS['note.delete'] = function (array $op) {
    people_staff($op);
    $note = QuickNote::lookup($op['args']['id']);
    return ['ok' => (bool) $note->delete()];
};

// ajax.orgs.php:addOrg
$OPS['org.create'] = function (array $op) {
    people_staff($op);
    $form = OrganizationForm::getDefaultForm()->getForm($op['args']['fields']);
    $org = Organization::fromForm($form);
    return ['ok' => (bool) $org, 'id' => $org ? $org->getId() : null, 'errors' => $org ? [] : $form->errors()];
};

// ajax.orgs.php:updateOrg (profile=false: campi; profile=true: impostazioni)
$OPS['org.update'] = function (array $op) {
    people_staff($op);
    $org = people_org($op);
    $errors = [];
    $ok = !empty($op['args']['profile'])
        ? $org->updateProfile($op['args']['vars'], $errors)
        : $org->update($op['args']['vars'], $errors);
    if (!$ok) foreach ($org->getForms() as $e) $errors[] = $e->errors();
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

$OPS['org.delete'] = function (array $op) {
    people_staff($op);
    return ['ok' => (bool) people_org($op)->delete()];
};

// scp/orgs.php a=remove-users
$OPS['org.removeusers'] = function (array $op) {
    people_staff($op);
    $org = people_org($op);
    $i = 0;
    foreach ($op['args']['ids'] as $v)
        if (($u = User::lookup($v)) && $org->removeUser($u)) $i++;
    return ['ok' => $i > 0, 'count' => $i];
};

// ajax.orgs.php:addUser
$OPS['org.adduser'] = function (array $op) {
    global $thisstaff;
    $thisstaff = people_staff($op);
    $org = people_org($op);
    if (!empty($op['args']['userId'])) {
        $user = User::lookup($op['args']['userId']);
    } else {
        $form = UserForm::getUserForm()->getForm($op['args']['fields']);
        $user = User::fromForm($form, $thisstaff->hasPerm(User::PERM_CREATE));
    }
    return ['ok' => (bool) ($user && $user->setOrganization($org)), 'id' => $user ? $user->getId() : null];
};

/* ============================== PROFILO ============================== */

// scp/profile.php (Staff::updateProfile)
$OPS['profile.update'] = function (array $op) {
    $staff = people_staff($op);
    $vars = $op['args']['vars'] + ['id' => $staff->getId()];
    $errors = [];
    $ok = $staff->updateProfile($vars, $errors);
    return ['ok' => (bool) $ok, 'errors' => $errors];
};

// ajax.staff.php:changePassword
$OPS['profile.password'] = function (array $op) {
    $staff = people_staff($op);
    if (!$staff->cmp_passwd($op['args']['current'])) return ['ok' => false, 'error' => 'current'];
    try {
        $staff->setPassword($op['args']['passwd1'], $op['args']['current']);
        return ['ok' => (bool) $staff->save()];
    } catch (BadPassword $ex) {
        return ['ok' => false, 'error' => $ex->getMessage()];
    }
};

// ajax.staff.php:configure2FA (stato validate → invio codice) ; verify con codice letto dalla sessione
$OPS['profile.2fa'] = function (array $op) {
    $staff = people_staff($op);
    $auth = Staff2FABackend::lookup('2fa-email');
    $config = ['config' => ['email' => $op['args']['email']], 'verified' => 0];
    $staff->updateConfig(['2fa-email' => JsonDataEncoder::encode($config)]);
    $token = $auth->send($staff);
    $otp = $_SESSION['_2fa']['2fa-email']['otp'];
    $form = $auth->getInputForm(['token' => $otp]);
    $ok = $form->isValid() && $auth->validate($form, $staff);
    if ($ok && ($config = $staff->get2FAConfig('2fa-email'))) {
        $config['verified'] = $op['args']['verified'] ?? time();
        $staff->updateConfig(['2fa-email' => JsonDataEncoder::encode($config)]);
    }
    if (isset($op['args']['default'])) {
        $staff->updateConfig(['default_2fa' => $op['args']['default']]);
    }
    return ['ok' => (bool) $ok];
};

// scp/pwreset.php do=sendmail
$OPS['staff.pwreset.send'] = function (array $op) {
    $_POST['userid'] = $op['args']['userid'];
    $staff = Staff::lookup($op['args']['userid']);
    if (!$staff || !$staff->hasPassword()) return ['ok' => false];
    $rv = $staff->sendResetEmail();
    return ['ok' => !$rv];
};

// scp/pwreset.php do=newpasswd (PasswordResetTokenBackend) + cambio password forzato
$OPS['staff.pwreset.login'] = function (array $op) {
    global $thisstaff;
    $_POST['userid'] = $op['args']['userid'];
    $_POST['token'] = $op['args']['token'];
    $errors = [];
    $staff = StaffAuthenticationBackend::processSignOn($errors);
    if (!$staff) return ['ok' => false, 'errors' => $errors];
    if (isset($op['args']['passwd1'])) {
        $s = Staff::lookup($staff->getId());
        $s->setPassword($op['args']['passwd1'], null);
        $s->save();
        $s->cancelResetTokens();
    }
    return ['ok' => true, 'staffId' => $staff->getId()];
};

// Login ripetuti nella stessa sessione PHP (contatore dei tentativi in $_SESSION)
$OPS['staff.login.many'] = function (array $op) {
    $out = [];
    foreach ($op['args']['attempts'] as $a) {
        $errors = [];
        $user = StaffAuthenticationBackend::process($a['login'], $a['password'], $errors);
        $out[] = $user instanceof Staff ? 'ok' : ($errors['err'] ?? 'invalid');
    }
    return ['ok' => true, 'results' => $out];
};
