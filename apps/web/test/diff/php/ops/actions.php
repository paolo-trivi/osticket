<?php
/**
 * Operazioni PHP dell'area "actions" (assegnazione, presa in carico, rilascio, trasferimento,
 * referral, cambio stato, segna risposto) per l'harness differenziale. Ogni closure riproduce il
 * percorso di include/ajax.tickets.php con il codice originale di osTicket (stessi form, stessi
 * controlli, stesse chiamate a Ticket::*).
 */

if (!function_exists('actions_staff')) {
    function actions_staff(array $op) {
        $s = Staff::lookup($op['args']['agent']);
        $GLOBALS['thisstaff'] = $s;
        return $s;
    }
    function actions_ticket(array $op) {
        $t = Ticket::lookup($op['args']['ticket']);
        if (!$t) throw new Exception('ticket mancante');
        return $t;
    }
    function actions_errors($errors, $form=null) {
        $out = $errors ?: array();
        if ($form)
            foreach ($form->errors() ?: array() as $k => $v)
                $out['form.'.$k] = $v;
        foreach ($form ? $form->getFields() : array() as $name => $f)
            if ($f->errors())
                $out['field.'.$name] = $f->errors();
        return $out;
    }
}

// ajax.tickets.php:assign($tid, $target)
$OPS['actions.assign'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    $target = $a['target'] ?? (substr($a['assignee'], 0, 1) == 't' ? 'teams' : 'agents');
    $post = array('assignee' => $a['assignee'], 'comments' => $a['comments'] ?? '');
    if (!empty($a['refer'])) $post['refer'] = 1;
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_ASSIGN)
            || !($form = $ticket->getAssignmentForm($post, array('target' => $target))))
        return ['ok' => false, 'error' => 403];
    $errors = array();
    if ($form->isValid() && $ticket->assign($form, $errors))
        return ['ok' => true];
    return ['ok' => false, 'errors' => actions_errors($errors, $form)];
};

// ajax.tickets.php:claim($tid)
$OPS['actions.claim'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $post = array('comments' => $op['args']['comments'] ?? '');
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_ASSIGN)
            || !$ticket->isOpen()
            || $ticket->getStaff()
            || !($form = $ticket->getClaimForm($post)))
        return ['ok' => false, 'error' => 403];
    // getClaimForm con $source: l'assegnatario arriva dal campo nascosto del form
    $post['assignee'] = array(sprintf('s%d', $thisstaff->getId()));
    $form = $ticket->getClaimForm($post);
    $errors = array();
    if ($form->isValid() && $ticket->claim($form, $errors))
        return ['ok' => true];
    return ['ok' => false, 'errors' => actions_errors($errors, $form)];
};

// ajax.tickets.php:release($tid)
$OPS['actions.release'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_RELEASE) && !$thisstaff->isManager())
        return ['ok' => false, 'error' => 403];
    $errors = array();
    if (!$ticket->isAssigned())
        $errors['err'] = __('Ticket is not assigned!');
    $post = array('comments' => $a['comments'] ?? '');
    if (!empty($a['sid'])) $post['sid'] = $ticket->getStaffId();
    if (!empty($a['tid'])) $post['tid'] = $ticket->getTeamId();
    $form = ReleaseForm::instantiate($post);
    $hasData = ($post['sid'] || $post['tid']);
    $staff = $ticket->getStaff();
    $team = $ticket->getTeam();
    if ($hasData && $ticket->release($post, $errors)) {
        $data = array();
        if ($staff && !$ticket->getStaff())
            $data['staff'] = array($staff->getId(), (string) $staff->getName()->getOriginal());
        if ($team && !$ticket->getTeam())
            $data['team'] = $team->getId();
        $ticket->logEvent('released', $data);
        $comments = $form->getComments();
        if ($comments) {
            $title = __('Assignment Released');
            $_errors = array();
            $ticket->postNote(
                array('note' => $comments, 'title' => $title),
                $_errors, $thisstaff, false);
        }
        return ['ok' => true];
    }
    return ['ok' => false, 'errors' => $errors];
};

// ajax.tickets.php:transfer($tid)
$OPS['actions.transfer'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_TRANSFER))
        return ['ok' => false, 'error' => 403];
    $post = array('dept' => $a['dept'], 'comments' => $a['comments'] ?? '');
    if (!empty($a['refer'])) $post['refer'] = 1;
    $form = $ticket->getTransferForm($post);
    $errors = array();
    if ($form->isValid() && $ticket->transfer($form, $errors))
        return ['ok' => true];
    return ['ok' => false, 'errors' => actions_errors($errors, $form)];
};

// ajax.tickets.php:refer($tid) con do=refer
$OPS['actions.refer'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    $post = array('target' => $a['target'], $a['target'] => $a['id'], 'comments' => $a['comments'] ?? '');
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_ASSIGN)
            || !($form = $ticket->getReferralForm($post, array('target' => null))))
        return ['ok' => false, 'error' => 403];
    $errors = array();
    if ($form->isValid() && $ticket->refer($form, $errors)) {
        $clean = $form->getClean();
        if ($clean['comments'])
            $ticket->logNote('Referral', $clean['comments'], $thisstaff);
        return ['ok' => true];
    }
    return ['ok' => false, 'errors' => actions_errors($errors, $form)];
};

// ajax.tickets.php:setTicketStatus($tid)
$OPS['actions.status'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    if (!$ticket->checkStaffPerm($thisstaff))
        return ['ok' => false, 'error' => 404];
    $errors = array();
    $status = null;
    if (!$a['status_id'] || !($status = TicketStatus::lookup($a['status_id'])))
        $errors['status_id'] = 'invalid';
    elseif ($status->getId() == $ticket->getStatusId())
        $errors['err'] = 'already';
    elseif (($role = $ticket->getRole($thisstaff))) {
        switch (mb_strtolower($status->getState())) {
            case 'open':
                if (!$role->hasPerm(Ticket::PERM_CLOSE) && !$role->hasPerm(Ticket::PERM_CREATE))
                    $errors['err'] = 'perm';
                break;
            case 'closed':
                if (!$role->hasPerm(Ticket::PERM_CLOSE))
                    $errors['err'] = 'perm';
                break;
            default:
                $errors['err'] = 'invalid';
        }
    }
    if (!$errors && $ticket->setStatus($status, $a['comments'] ?? '', $errors)) {
        $failures = array();
        if (!empty($a['children'])) {
            foreach ($ticket->getChildren() as $cid) {
                $child = Ticket::lookup($cid[0]);
                if (!$child->setStatus($status, '', $errors))
                    $failures[$cid[0]] = $child->getNumber();
            }
        }
        return ['ok' => true, 'failures' => $failures];
    }
    return ['ok' => false, 'errors' => $errors];
};

// ajax.tickets.php:markAs($tid, $action)
$OPS['actions.mark'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    $a = $op['args'];
    $action = $a['action'];
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_MARKANSWERED) && !$thisstaff->isManager($ticket->getDept()))
        return ['ok' => false, 'error' => 403];
    $errors = array();
    $form = MarkAsForm::instantiate(array('comments' => $a['comments'] ?? ''));
    switch ($action) {
        case 'answered':
            if ($ticket->isAnswered())
                $errors['err'] = 'already';
            elseif (!$ticket->markAnswered())
                $errors['err'] = 'fail';
            break;
        case 'unanswered':
            if (!$ticket->isAnswered())
                $errors['err'] = 'already';
            elseif (!$ticket->markUnAnswered())
                $errors['err'] = 'fail';
            break;
    }
    if ($errors)
        return ['ok' => false, 'errors' => $errors];
    $comments = $form->getComments();
    if ($comments) {
        $title = __(sprintf('Ticket Marked %s', ucfirst($action)));
        $_errors = array();
        $ticket->postNote(
            array('note' => $comments, 'title' => $title),
            $_errors, $thisstaff, false);
    }
    $msg = sprintf(__('Ticket flagged as %s by %s'), $action, $thisstaff->getName());
    $ticket->logActivity(sprintf(__('Ticket Marked %s'), ucfirst($action)), $msg);
    return ['ok' => true];
};

// ajax.tickets.php:refer($tid) con do=manage: rimozione dei referral selezionati ('-<id>')
$OPS['actions.referrals.remove'] = function (array $op) {
    $thisstaff = actions_staff($op);
    $ticket = actions_ticket($op);
    if (!$ticket->checkStaffPerm($thisstaff, Ticket::PERM_ASSIGN)
            || !($form = $ticket->getReferralForm(array('do' => 'manage'), array('target' => null))))
        return ['ok' => false, 'error' => 403];
    $referrals = array();
    foreach ($ticket->getThread()->referrals as $r)
        $referrals[] = in_array($r->getId(), $op['args']['ids']) ? '-'.$r->getId() : (string) $r->getId();
    // ids non appartenenti al thread: il form le invierebbe comunque se manipolato
    foreach ($op['args']['ids'] as $id)
        if (!in_array('-'.$id, $referrals))
            $referrals[] = '-'.$id;
    $remove = array();
    foreach ($referrals as $k => $v)
        if ($v[0] == '-')
            $remove[] = substr($v, 1);
    $num = 0;
    if (count($remove))
        $num = $ticket->getThread()->referrals
            ->filter(array('id__in' => $remove))
            ->delete();
    return ['ok' => true, 'removed' => $num];
};
