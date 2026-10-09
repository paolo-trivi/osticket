<?php
/**
 * Operazioni PHP dell'area "ticketedit" (modifica ticket, campi, collaboratori, merge/link,
 * eliminazione, segna scaduto, ban list, azioni di massa, export CSV, modifica voci del thread)
 * per l'harness differenziale. Ogni closure ripercorre scp/tickets.php, include/ajax.tickets.php e
 * include/ajax.thread.php con il codice originale di osTicket.
 */

if (!function_exists('te_staff')) {
    function te_staff(array $op) {
        $s = Staff::lookup($op['args']['agent']);
        $GLOBALS['thisstaff'] = $s;
        return $s;
    }
    function te_ticket(array $op, $key='ticket') {
        $t = Ticket::lookup($op['args'][$key]);
        if (!$t) throw new Exception('ticket mancante');
        return $t;
    }
    /** Simula una richiesta POST con i dati indicati */
    function te_post(array $data) {
        $_POST = $data;
        $_REQUEST = $data;
        $_SERVER['REQUEST_METHOD'] = 'POST';
    }
    function te_errors($errors, $form=null) {
        $out = array();
        foreach ($errors ?: array() as $k => $v)
            $out[$k] = is_array($v) ? array_values($v) : (string) $v;
        if ($form)
            foreach ($form->getFields() as $name => $f)
                if ($f->errors())
                    $out['field.'.($f->get('name') ?: $name)] = array_values($f->errors());
        return $out;
    }
}

// ajax.tickets.php:setTicketStatus($tid), compreso lo stato "deleted" (Ticket::delete)
$OPS['ticketedit.status'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff))
        return ['ok' => false, 'error' => 404];
    te_post(array('status_id' => $a['status_id'], 'comments' => $a['comments'] ?? '',
        'children' => !empty($a['children']) ? 1 : 0));
    $errors = array();
    $status = TicketStatus::lookup($a['status_id']);
    if (!$status)
        return ['ok' => false, 'error' => 'status'];
    if ($status->getId() == $ticket->getStatusId())
        return ['ok' => false, 'error' => 'already'];
    $role = $ticket->getRole($thisstaff);
    switch (mb_strtolower($status->getState())) {
    case 'open':
        if (!$role->hasPerm(Ticket::PERM_CLOSE) && !$role->hasPerm(Ticket::PERM_CREATE))
            return ['ok' => false, 'error' => 'perm'];
        break;
    case 'closed':
        if (!$role->hasPerm(Ticket::PERM_CLOSE))
            return ['ok' => false, 'error' => 'perm'];
        break;
    case 'deleted':
        if (!$role->hasPerm(Ticket::PERM_DELETE))
            return ['ok' => false, 'error' => 'perm'];
        break;
    default:
        return ['ok' => false, 'error' => 'invalid'];
    }
    if (!$ticket->setStatus($status, $_REQUEST['comments'], $errors))
        return ['ok' => false, 'errors' => te_errors($errors)];
    $failures = array();
    if ($_REQUEST['children']) {
        foreach ($ticket->getChildren() as $cid) {
            $child = Ticket::lookup($cid[0]);
            if (!$child->setStatus($status, '', $errors))
                $failures[$cid[0]] = $child->getNumber();
        }
    }
    return ['ok' => true, 'failures' => $failures];
};

// Ticket::delete($comments) diretto (azione di massa "delete")
$OPS['ticketedit.delete'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_DELETE))
        return ['ok' => false, 'error' => 403];
    return ['ok' => (bool) $ticket->delete($op['args']['comments'] ?? '')];
};

// scp/tickets.php a=update: Ticket::update($_POST)
$OPS['ticketedit.update'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $a = $op['args'];
    $role = $ticket->getRole($thisstaff);
    if (!$role || !$role->hasPerm(Ticket::PERM_EDIT))
        return ['ok' => false, 'error' => 403];
    $post = $a['post'];
    $post['a'] = 'update';
    $post['id'] = $ticket->getId();
    if (!isset($post['forms'])) {
        $post['forms'] = array();
        foreach (DynamicFormEntry::forTicket($ticket->getId()) as $f)
            $post['forms'][] = $f->getId();
    }
    te_post($post);
    $errors = array();
    if ($ticket->update($_POST, $errors))
        return ['ok' => true];
    return ['ok' => false, 'errors' => te_errors($errors)];
};

// ajax.tickets.php:editField($tid, $fid) in POST
$OPS['ticketedit.field'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_EDIT))
        return ['ok' => false, 'error' => 403];
    if (!($field = $ticket->getField($a['field'])))
        return ['ok' => false, 'error' => 404];
    $post = $a['post'];
    te_post($post);
    $errors = array();
    $form = $field->getEditForm($_POST);
    if ($form->isValid()) {
        if ($ticket->updateField($form, $errors))
            return ['ok' => true];
    }
    return ['ok' => false, 'errors' => te_errors($errors, $form)];
};

// scp/tickets.php a=process do=changeuser
$OPS['ticketedit.changeuser'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $role = $ticket->getRole($thisstaff);
    if (!$role->hasPerm(Ticket::PERM_EDIT))
        return ['ok' => false, 'error' => 403];
    if (!($user = User::lookup($op['args']['user_id'])))
        return ['ok' => false, 'error' => 'user'];
    return ['ok' => (bool) $ticket->changeOwner($user)];
};

// scp/tickets.php a=process do=addcc
$OPS['ticketedit.addcc'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $role = $ticket->getRole($thisstaff);
    if (!$role->hasPerm(Ticket::PERM_EDIT))
        return ['ok' => false, 'error' => 403];
    if (!($user = User::lookup($op['args']['user_id'])))
        return ['ok' => false, 'error' => 'user'];
    $errors = array();
    if ($c2 = $ticket->addCollaborator($user, array(), $errors)) {
        $c2->setFlag(Collaborator::FLAG_CC, true);
        $c2->save();
        return ['ok' => true];
    }
    return ['ok' => false, 'errors' => te_errors($errors)];
};

// ajax.thread.php:addCollaborator($tid) con utente esistente (POST id)
$OPS['ticketedit.collab.add'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    if (!$ticket->checkStaffPerm($thisstaff))
        return ['ok' => false, 'error' => 404];
    te_post(array('id' => $op['args']['user_id']));
    $user = User::lookup($_POST['id']);
    $errors = $vars = array();
    if ($user && ($c = $ticket->addCollaborator($user, $vars, $errors)))
        return ['ok' => true, 'id' => $c->getId()];
    return ['ok' => false, 'errors' => te_errors($errors)];
};

// ajax.thread.php:updateCollaborators($tid): del[] (rimozione) e cid[] (attivi)
$OPS['ticketedit.collab.update'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    if (!$ticket->checkStaffPerm($thisstaff))
        return ['ok' => false, 'error' => 404];
    $post = array();
    if (isset($op['args']['del'])) $post['del'] = $op['args']['del'];
    if (isset($op['args']['cid'])) $post['cid'] = $op['args']['cid'];
    te_post($post);
    $errors = array();
    $ticket->getThread()->updateCollaborators($_POST, $errors);
    return ['ok' => !$errors, 'errors' => te_errors($errors)];
};

// ajax.tickets.php:updateMerge($tid): merge/link (tids) o scollegamento (dtids)
$OPS['ticketedit.merge'] = function (array $op) {
    $thisstaff = te_staff($op);
    te_post($op['args']['post']);
    if ($_POST['dtids']) {
        foreach ($_POST['dtids'] as $key => $value) {
            if (is_numeric($key) && $ticket = Ticket::lookup($value))
                $ticket->unlink();
        }
        return ['ok' => true];
    } elseif ($_POST['tids']) {
        if ($parent = Ticket::merge($_POST))
            return ['ok' => true];
        return ['ok' => false, 'error' => 404];
    }
    return ['ok' => false];
};

// scp/tickets.php a=process do=overdue
$OPS['ticketedit.overdue'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $dept = $ticket->getDept();
    if (!$dept || !$dept->isManager($thisstaff))
        return ['ok' => false, 'error' => 403];
    if ($ticket->markOverdue()) {
        $msg = sprintf(__('Ticket flagged as overdue by %s'), $thisstaff->getName());
        $ticket->logActivity(__('Ticket Marked Overdue'), $msg);
        return ['ok' => true];
    }
    return ['ok' => false, 'error' => 'failed'];
};

// scp/tickets.php a=process do=banemail / unbanemail
$OPS['ticketedit.ban'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    if (!$thisstaff->hasPerm(Email::PERM_BANLIST))
        return ['ok' => false, 'error' => 403];
    if ($op['args']['ban']) {
        if (BanList::includes($ticket->getEmail()))
            return ['ok' => false, 'error' => 'already'];
        return ['ok' => (bool) Banlist::add($ticket->getEmail(), $thisstaff->getName())];
    }
    if (Banlist::remove($ticket->getEmail()))
        return ['ok' => true];
    if (!BanList::includes($ticket->getEmail()))
        return ['ok' => false, 'warn' => 'not_banned'];
    return ['ok' => false, 'error' => 'failed'];
};

// ajax.tickets.php:massProcess($action, $w) in POST (assign, claim, transfer, delete)
$OPS['ticketedit.mass'] = function (array $op) {
    $thisstaff = te_staff($op);
    $a = $op['args'];
    $post = $a['post'];
    te_post($post);
    $action = $a['action'];
    $w = $a['what'] ?? null;
    $i = 0;
    $e = array();
    switch ($action) {
    case 'claim':
        $w = 'me';
    case 'assign':
        $form = AssignmentForm::instantiate($_POST);
        $assignCB = function($t, $f, $e) { return $t->assign($f, $e); };
        $assignees = null;
        switch ($w) {
        case 'agents':
            $depts = array();
            $tids = $_POST['tids'];
            $tickets = Ticket::objects()->distinct('dept_id')->filter(array('ticket_id__in' => $tids));
            $depts = $tickets->values_flat('dept_id');
            $members = $thisstaff->getDeptAgents(array('available' => true));
            if ($depts) {
                $all_agent_depts = Dept::objects()->filter(
                    Q::all(array('id__in' => $depts,
                    Q::not(array('flags__hasbit' => Dept::FLAG_ASSIGN_MEMBERS_ONLY)),
                    Q::not(array('flags__hasbit' => Dept::FLAG_ASSIGN_PRIMARY_ONLY))
                    )))->values_flat('id');
                if (!count($all_agent_depts)) {
                    $members->filter(Q::any(array(
                        'dept_id__in' => $depts,
                        Q::all(array(
                            'dept_access__dept__id__in' => $depts,
                            Q::not(array('dept_access__dept__flags__hasbit' => Dept::FLAG_ASSIGN_MEMBERS_ONLY,
                                'dept_access__dept__flags__hasbit' => Dept::FLAG_ASSIGN_PRIMARY_ONLY))
                        )))));
                }
            }
            $assignees = array();
            foreach ($members as $member)
                $assignees['s'.$member->getId()] = $member->getName();
            break;
        case 'teams':
            $assignees = array();
            foreach (Team::getActiveTeams() as $id => $name)
                $assignees['t'.$id] = $name;
            break;
        case 'me':
            $id = sprintf('s%s', $thisstaff->getId());
            $assignees = array($id => $thisstaff->getName());
            $vars = $_POST ?: array('assignee' => array($id));
            $vars['assignee'] = array($id);
            $form = ClaimForm::instantiate($vars);
            $assignCB = function($t, $f, $e) { return $t->claim($f, $e); };
            break;
        }
        if ($assignees != null)
            $form->setAssignees($assignees);
        if ($form->isValid()) {
            unset($thisstaff->ht['dept_access']);
            foreach ($_POST['tids'] as $tid) {
                if (($t = Ticket::lookup($tid))
                        && $t->checkStaffPerm($thisstaff, Ticket::PERM_ASSIGN)
                        && $assignCB($t, $form, $e))
                    $i++;
            }
        } else
            return ['ok' => false, 'errors' => te_errors(array(), $form)];
        break;
    case 'transfer':
        $form = TransferForm::instantiate($_POST);
        $form->hideDisabled();
        if ($form->isValid()) {
            foreach ($_POST['tids'] as $tid) {
                if (($t = Ticket::lookup($tid))
                        && $t->checkStaffPerm($thisstaff, Ticket::PERM_TRANSFER)
                        && $t->transfer($form, $e))
                    $i++;
            }
        } else
            return ['ok' => false, 'errors' => te_errors(array(), $form)];
        break;
    case 'delete':
        if (!$thisstaff->hasPerm(Ticket::PERM_DELETE, false))
            return ['ok' => false, 'error' => 403];
        foreach ($_POST['tids'] as $tid) {
            if (($t = Ticket::lookup($tid))
                    && $t->checkStaffPerm($thisstaff, Ticket::PERM_DELETE)
                    && $t->delete($_POST['comments'], $e))
                $i++;
        }
        break;
    }
    return ['ok' => $i > 0, 'count' => $i];
};

// ajax.tickets.php:setSelectedTicketsStatus($state) (cambio stato di massa)
$OPS['ticketedit.mass.status'] = function (array $op) {
    $thisstaff = te_staff($op);
    $a = $op['args'];
    te_post(array('tids' => $a['tids'], 'status_id' => $a['status_id'], 'comments' => $a['comments'] ?? ''));
    $errors = array();
    if (!$thisstaff->canManageTickets())
        return ['ok' => false, 'error' => 'manage'];
    $status = TicketStatus::lookup($_REQUEST['status_id']);
    if (!$status)
        return ['ok' => false, 'error' => 'status'];
    switch (mb_strtolower($status->getState())) {
    case 'open':
        if (!$thisstaff->hasPerm(Ticket::PERM_CLOSE, false) && !$thisstaff->hasPerm(Ticket::PERM_CREATE, false))
            return ['ok' => false, 'error' => 'perm'];
        break;
    case 'closed':
        if (!$thisstaff->hasPerm(Ticket::PERM_CLOSE, false))
            return ['ok' => false, 'error' => 'perm'];
        break;
    case 'deleted':
        if (!$thisstaff->hasPerm(Ticket::PERM_DELETE, false))
            return ['ok' => false, 'error' => 'perm'];
        break;
    default:
        return ['ok' => false, 'error' => 'invalid'];
    }
    $i = 0;
    $comments = $_REQUEST['comments'];
    foreach ($_REQUEST['tids'] as $tid) {
        if (($ticket = Ticket::lookup($tid))
                && $ticket->getStatusId() != $status->getId()
                && $ticket->checkStaffPerm($thisstaff)
                && $ticket->setStatus($status, $comments, $errors))
            $i++;
    }
    return ['ok' => $i > 0, 'count' => $i];
};

// TEA_EditThreadEntry / TEA_EditAndResendThreadEntry (senza reinvio): ThreadEntry::updateEntry
$OPS['ticketedit.entry.edit'] = function (array $op) {
    $thisstaff = te_staff($op);
    $ticket = te_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff))
        return ['ok' => false, 'error' => 404];
    $entry = ThreadEntry::lookup($a['entry']);
    if (!$entry || $entry->getThread()->getObjectType() != 'T'
            || $entry->getThread()->getObjectId() != $ticket->getId())
        return ['ok' => false, 'error' => 404];
    include_once INCLUDE_DIR . 'class.thread_actions.php';
    te_post(array('body' => $a['body'], 'title' => $a['title'] ?? '', 'commit' => 'save'));
    $action = null;
    foreach ($entry->getActions() as $group => $list)
        foreach ($list as $id => $A)
            if ($id == 'edit' || $id == 'edit_resend')
                $action = $A;
    if (!$action || !$action->isEnabled())
        return ['ok' => false, 'error' => 403];
    $new = $action->updateEntry(false);
    return ['ok' => (bool) $new, 'id' => $new ? $new->getId() : null];
};

// CustomQueue::export su un CsvExporter (ajax.tickets.php:queueExport), contenuto restituito
$OPS['ticketedit.export'] = function (array $op) {
    $thisstaff = te_staff($op);
    $a = $op['args'];
    $queue = SavedQueue::lookup($a['queue']);
    if (!$queue || !$queue->checkAccess($thisstaff))
        return ['ok' => false, 'error' => 404];
    $exporter = new CsvExporter(array('filename' => 'x.csv', 'delimiter' => $a['delimiter'] ?? ','));
    if (isset($a['fields']))
        $_SESSION['Export:Q'.$queue->getId()]['fields'] = $a['fields'];
    $queue->export($exporter);
    $exporter->finalize(false);
    $content = file_get_contents($exporter->getFile());
    @$exporter->delete();
    return ['ok' => true, 'csv' => base64_encode($content)];
};
