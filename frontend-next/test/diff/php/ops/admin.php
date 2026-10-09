<?php
/**
 * Operazioni PHP dell'area "admin" (impostazioni, reparti, help topic, SLA, orari, agenti, team,
 * ruoli). Ogni operazione riproduce il ramo POST della relativa pagina scp/*.php (o del gestore
 * ajax) chiamando le classi originali di osTicket con le stesse variabili del form.
 */

require_once INCLUDE_DIR.'class.user.php';
require_once INCLUDE_DIR.'class.organization.php';
require_once INCLUDE_DIR.'class.canned.php';
require_once INCLUDE_DIR.'class.faq.php';
require_once INCLUDE_DIR.'class.email.php';
require_once INCLUDE_DIR.'class.report.php';
require_once INCLUDE_DIR.'class.thread.php';
require_once INCLUDE_DIR.'class.topic.php';
require_once INCLUDE_DIR.'class.sla.php';
require_once INCLUDE_DIR.'class.schedule.php';
require_once INCLUDE_DIR.'class.businesshours.php';
require_once INCLUDE_DIR.'class.team.php';
require_once INCLUDE_DIR.'class.role.php';
require_once INCLUDE_DIR.'class.dynamic_forms.php';

/** Agente amministratore corrente. */
function admin_staff(array $op) {
    $staff = Staff::lookup($op['args']['agent'] ?? 1);
    $GLOBALS['thisstaff'] = $staff;
    return $staff;
}

/** Errori annidati → stringhe (come adminsys_errors). */
function admin_errors($errors) {
    $out = array();
    foreach ((array) $errors as $k => $v)
        $out[$k] = is_scalar($v) ? (string) $v : json_encode($v);
    return $out;
}

/** POST simulato: le classi leggono anche $_POST direttamente (company form, sort-<id>). */
function admin_post(array $vars) {
    $_POST = $vars;
    $_REQUEST = $vars;
    $_SERVER['REQUEST_METHOD'] = 'POST';
    return $vars;
}

// Elenco ordinato dei permessi registrati (RolePermission::allPermissions) per il codice TS
$OPS['admin.perms'] = function (array $op) {
    $out = array();
    foreach (RolePermission::allPermissions() as $g => $perms)
        foreach ($perms as $k => $v)
            $out[] = [$g, $k, $v['title'], $v['desc'], !empty($v['primary'])];
    return ['ok' => true, 'perms' => $out];
};

// ---------------------------------------------------------------- Impostazioni (scp/settings.php)
$OPS['admin.settings'] = function (array $op) {
    global $cfg;
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    $ok = $cfg->updateSettings($vars, $errors);
    return ['ok' => (bool) $ok, 'errors' => admin_errors($errors)];
};

// ---------------------------------------------------------------- Reparti (scp/departments.php)
$OPS['admin.dept.save'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $dept = Dept::lookup($op['args']['id']);
        $ok = $dept->update($vars, $errors);
    } else {
        $dept = Dept::create();
        $ok = $dept->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $dept->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.dept.mass'] = function (array $op) {
    global $cfg;
    admin_staff($op);
    $_POST = admin_post(['ids' => $op['args']['ids'], 'a' => $op['args']['a']]);
    $errors = array();
    $num = 0;
    if (in_array($cfg->getDefaultDeptId(), $_POST['ids']))
        return ['ok' => false, 'error' => 'default'];
    $count = count($_POST['ids']);
    switch (strtolower($_POST['a'])) {
    case 'make_public':
        $sql='UPDATE '.DEPT_TABLE.' SET ispublic=1 '
            .' WHERE dept_id IN ('.implode(',', db_input($_POST['ids'])).')';
        // NB: la colonna si chiama "id": la query del PHP fallisce sempre (bug replicato: nessuna scrittura)
        $ok = db_query($sql, false);
        return ['ok' => (bool) $ok, 'num' => $ok ? db_affected_rows() : 0];
    case 'make_private':
        $sql='UPDATE '.DEPT_TABLE.' SET ispublic=0  '
            .' WHERE dept_id IN ('.implode(',', db_input($_POST['ids'])).') '
            .' AND dept_id!='.db_input($cfg->getDefaultDeptId());
        $ok = db_query($sql, false);
        return ['ok' => (bool) $ok, 'num' => $ok ? db_affected_rows() : 0];
    case 'enable':
    case 'disable':
    case 'archive':
        $a = strtolower($_POST['a']);
        $depts = Dept::objects()->filter(array('id__in'=>$_POST['ids']))
            ->exclude(array('id'=>$cfg->getDefaultDeptId()));
        foreach ($depts as $d) {
            $d->setFlag(Dept::FLAG_ARCHIVED, $a == 'archive');
            $d->setFlag(Dept::FLAG_ACTIVE, $a == 'enable');
            $filter_actions = FilterAction::objects()->filter(array('type' => 'dept', 'configuration' => '{"dept_id":'. $d->getId().'}'));
            FilterAction::setFilterFlags($filter_actions, 'Filter::FLAG_INACTIVE_DEPT', $a != 'enable');
            if ($d->save())
                $num++;
        }
        return ['ok' => $num > 0, 'num' => $num];
    case 'delete':
        $sql='SELECT count(staff_id) FROM '.STAFF_TABLE
            .' WHERE dept_id IN ('.implode(',', db_input($_POST['ids'])).')';
        list($members)=db_fetch_row(db_query($sql));
        if ($members)
            return ['ok' => false, 'error' => 'has_members'];
        $i = 0;
        foreach ($_POST['ids'] as $k=>$v) {
            if ($v!=$cfg->getDefaultDeptId() && ($d=Dept::lookup($v))) {
                $d->delete();
                $i++;
            }
        }
        return ['ok' => $i > 0, 'num' => $i];
    }
    return ['ok' => false];
};

// ---------------------------------------------------------------- Help topic (scp/helptopics.php)
$OPS['admin.topic.save'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $topic = Topic::lookup($op['args']['id']);
        $ok = $topic->update($vars, $errors);
    } else {
        $topic = Topic::create();
        $ok = $topic->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $topic->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.topic.mass'] = function (array $op) {
    global $cfg;
    admin_staff($op);
    $_POST = admin_post(($op['args']['post'] ?? []) + ['ids' => $op['args']['ids'] ?? null, 'a' => $op['args']['a']]);
    $errors = array();
    $count=$_POST['ids']?count($_POST['ids']):0;
    $activeTopics = Topic::getHelpTopics(false, false);
    $allTopics = count(Topic::getAllHelpTopics());
    $diff = is_array($_POST['ids']) ? array_intersect($_POST['ids'], array_keys($activeTopics)) : [];
    $num = 0;
    switch (strtolower($_POST['a'])) {
    case 'enable':
        $topics = Topic::objects()->filter(array('topic_id__in'=>$_POST['ids']));
        foreach ($topics as $t) {
            $t->setFlag(Topic::FLAG_ARCHIVED, false);
            $t->setFlag(Topic::FLAG_ACTIVE, true);
            $filter_actions = FilterAction::objects()->filter(array('type' => 'topic', 'configuration' => '{"topic_id":'. $t->getId().'}'));
            FilterAction::setFilterFlags($filter_actions, 'Filter::FLAG_INACTIVE_HT', false);
            if ($t->save())
                $num++;
        }
        return ['ok' => $num > 0, 'num' => $num];
    case 'disable':
    case 'archive':
        $a = strtolower($_POST['a']);
        $topics = Topic::objects()->filter(array('topic_id__in'=>$_POST['ids']))
            ->exclude(array('topic_id'=>$cfg->getDefaultTopicId()));
        if (($count >= $allTopics) || (count($diff) == count($activeTopics)))
            return ['ok' => false, 'error' => 'one_active'];
        foreach ($topics as $t) {
            $t->setFlag(Topic::FLAG_ARCHIVED, $a == 'archive');
            $t->setFlag(Topic::FLAG_ACTIVE, false);
            $filter_actions = FilterAction::objects()->filter(array('type' => 'topic', 'configuration' => '{"topic_id":'. $t->getId().'}'));
            FilterAction::setFilterFlags($filter_actions, 'Filter::FLAG_INACTIVE_HT', true);
            if ($t->save())
                $num++;
        }
        return ['ok' => $num > 0, 'num' => $num];
    case 'delete':
        $i = 1;
        $topics = Topic::objects()->filter(array('topic_id__in'=>$_POST['ids']));
        if (($count >= $allTopics) || count($diff) == count($activeTopics))
            return ['ok' => false, 'error' => 'one_active'];
        foreach ($topics as $t) {
            if ($t->getId()!=$cfg->getDefaultTopicId() && $t->delete())
                $i++;
        }
        return ['ok' => $i > 1, 'num' => $i - 1];
    case 'sort':
        try {
            $cfg->setTopicSortMode($_POST['help_topic_sort_mode']);
            if ($cfg->getTopicSortMode() == 'm') {
                foreach ($_POST as $k=>$v) {
                    if (strpos($k, 'sort-') === 0
                            && is_numeric($v)
                            && ($t = Topic::lookup(substr($k, 5))))
                        $t->setSortOrder($v);
                }
            }
            return ['ok' => true];
        } catch (Exception $ex) {
            return ['ok' => false, 'error' => 'sort_mode'];
        }
    }
    return ['ok' => false];
};

// ---------------------------------------------------------------- SLA (scp/slas.php)
$OPS['admin.sla.save'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $sla = SLA::lookup($op['args']['id']);
        $ok = $sla->update($vars, $errors);
    } else {
        $sla = SLA::create();
        $ok = $sla->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $sla->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.sla.mass'] = function (array $op) {
    global $cfg;
    admin_staff($op);
    $_POST = admin_post(['ids' => $op['args']['ids'], 'a' => $op['args']['a']]);
    switch (strtolower($_POST['a'])) {
    case 'enable':
        $num = SLA::objects()->filter(array('id__in' => $_POST['ids']))
            ->update(array('flags' => SqlExpression::bitor(new SqlField('flags'), SLA::FLAG_ACTIVE)));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'disable':
        $num = SLA::objects()->filter(array('id__in' => $_POST['ids']))
            ->update(array('flags' => SqlExpression::bitand(new SqlField('flags'), ~SLA::FLAG_ACTIVE)));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'delete':
        $i = 0;
        foreach ($_POST['ids'] as $k => $v) {
            if (($p=SLA::lookup($v)) && $p->getId() != $cfg->getDefaultSLAId() && $p->delete())
                $i++;
        }
        return ['ok' => $i > 0, 'num' => $i];
    }
    return ['ok' => false];
};

// ---------------------------------------------------------------- Orari (scp/schedules.php + ajax.schedule.php)
$OPS['admin.schedule.add'] = function (array $op) {
    admin_staff($op);
    $_POST = admin_post($op['args']['vars']);
    $schedule = !empty($op['args']['clone']) ? Schedule::lookup($op['args']['clone']) : null;
    $form = Schedule::basicForm($_POST);
    if ($form->isValid()) {
        $data = $form->getClean();
        if (Schedule::getIdByName($data['name']))
            return ['ok' => false, 'error' => 'name_in_use'];
        if ($schedule && strcasecmp($schedule->getType(), $data['type']))
            return ['ok' => false, 'error' => 'type'];
        $vars = array_intersect_key($data, array_flip(['name', 'timezone', 'description']));
        $s = Schedule::create($vars);
        $s->setFlag(Schedule::FLAG_BIZHRS, ($data['type'] == 'bizhrs'));
        if ($s->save()) {
            if ($schedule) $s->cloneEntries($schedule);
            return ['ok' => true, 'id' => (int) $s->getId()];
        }
    }
    return ['ok' => false, 'errors' => admin_errors($form->errors())];
};

$OPS['admin.schedule.update'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $schedule = Schedule::lookup($op['args']['id']);
    $errors = array();
    $ok = $schedule->update($vars, $errors);
    return ['ok' => (bool) $ok, 'errors' => admin_errors($errors)];
};

$OPS['admin.schedule.delete'] = function (array $op) {
    admin_staff($op);
    $i = 0;
    foreach ($op['args']['ids'] as $v)
        if (($t=Schedule::lookup($v)) && $t->delete())
            $i++;
    return ['ok' => $i > 0, 'num' => $i];
};

$OPS['admin.schedule.entry'] = function (array $op) {
    admin_staff($op);
    $_POST = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['entry'])) {
        $entry = ScheduleEntry::lookup($op['args']['entry']);
        $form = $entry->getForm($_POST);
        $ok = $entry->update($form, $errors);
        $id = $ok ? $entry->getId() : null;
    } else {
        $schedule = Schedule::lookup($op['args']['schedule']);
        $form = $schedule->getEntryForm($_POST);
        $ok = false;
        $id = null;
        if ($form->isValid() && ($entry = $schedule->addEntry($form, $errors))) {
            $ok = true;
            $id = $entry->getId();
        }
    }
    return ['ok' => (bool) $ok, 'id' => $id, 'errors' => admin_errors($errors), 'formErrors' => admin_errors($form->errors())];
};

$OPS['admin.schedule.entries.delete'] = function (array $op) {
    admin_staff($op);
    $schedule = Schedule::lookup($op['args']['schedule']);
    $count = $schedule->entries->filter(array('id__in' => array_values($op['args']['ids'])))->delete();
    return ['ok' => true, 'num' => $count];
};

// ---------------------------------------------------------------- Agenti (scp/staff.php + ajax.staff.php)
$OPS['admin.staff.save'] = function (array $op) {
    admin_staff($op);
    $vars = $op['args']['vars'];
    $errors = array();
    if (!empty($op['args']['id'])) {
        $staff = Staff::lookup($op['args']['id']);
        $_POST = admin_post($vars);
        $ok = $staff->update($_POST, $errors);
    } else {
        $staff = Staff::create();
        // Password impostata dal dialogo (sessione new-agent-passwd) oppure email di benvenuto
        if (!empty($op['args']['passwd'])) {
            foreach ($op['args']['passwd'] as $k=>$v)
                if (!isset($vars[$k]))
                    $vars[$k] = $v;
        } else {
            $bk = array_key_exists('backend', $vars) ? $vars['backend'] : null;
            if (!$bk || $bk == 'local')
                $vars['welcome_email'] = 1;
        }
        $_POST = admin_post($vars);
        $ok = $staff->update($_POST, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $staff->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.staff.mass'] = function (array $op) {
    global $thisstaff;
    admin_staff($op);
    $_POST = admin_post(($op['args']['post'] ?? []) + ['ids' => $op['args']['ids'], 'a' => $op['args']['a']]);
    $errors = array();
    if (in_array($_POST['a'], array('disable', 'delete')) && in_array($thisstaff->getId(), $_POST['ids']))
        return ['ok' => false, 'error' => 'self'];
    $members = Staff::objects()->filter(array('staff_id__in' => $_POST['ids']));
    $i = 0;
    switch (strtolower($_POST['a'])) {
    case 'enable':
        $num = $members->update(array('isactive' => 1));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'disable':
        $num = $members->update(array('isactive' => 0));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'delete':
        foreach ($members as $s) {
            if ($s->staff_id != $thisstaff->getId()) {
                $s->delete();
                $i++;
            }
        }
        return ['ok' => $i > 0, 'num' => $i];
    case 'permissions':
        foreach ($members as $s)
            if ($s->updatePerms($_POST['perms'], $errors) && $s->save())
                $i++;
        return ['ok' => $i > 0, 'num' => $i];
    case 'department':
        if (!$_POST['dept_id'] || !$_POST['role_id']
            || !Dept::lookup($_POST['dept_id'])
            || !Role::lookup($_POST['role_id']))
            return ['ok' => false, 'error' => 'internal'];
        foreach ($members as $s) {
            $s->setDepartmentId((int) $_POST['dept_id'], $_POST['eavesdrop']);
            $s->role_id = (int) $_POST['role_id'];
            if ($s->save() && $s->dept_access->saveAll())
                $i++;
        }
        return ['ok' => $i > 0, 'num' => $i];
    }
    return ['ok' => false];
};

// ajax.staff.php:setPassword per un agente esistente (email di reset o password impostata)
$OPS['admin.staff.setpasswd'] = function (array $op) {
    admin_staff($op);
    $_POST = admin_post($op['args']['vars']);
    $staff = Staff::lookup($op['args']['id']);
    $form = new PasswordResetForm($_POST);
    if (!$form->isValid())
        return ['ok' => false, 'formErrors' => admin_errors($form->errors())];
    $clean = $form->getClean();
    try {
        if (!$clean['welcome_email'])
            Staff::checkPassword($clean['passwd1'], null);
        if ($clean['welcome_email'])
            $staff->sendResetEmail();
        else {
            $staff->setPassword($clean['passwd1'], null);
            if ($clean['change_passwd'])
                $staff->change_passwd = 1;
        }
        return ['ok' => (bool) $staff->save()];
    } catch (BadPassword $ex) {
        return ['ok' => false, 'error' => 'bad_password'];
    }
};

// ---------------------------------------------------------------- Team (scp/teams.php)
$OPS['admin.team.save'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $team = Team::lookup($op['args']['id']);
        $ok = $team->update($vars, $errors);
    } else {
        $team = Team::create();
        $ok = $team->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $team->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.team.mass'] = function (array $op) {
    admin_staff($op);
    $_POST = admin_post(['ids' => $op['args']['ids'], 'a' => $op['args']['a']]);
    switch (strtolower($_POST['a'])) {
    case 'enable':
        $num = Team::objects()->filter(array('team_id__in' => $_POST['ids']))
            ->update(array('flags' => SqlExpression::bitor(new SqlField('flags'), Team::FLAG_ENABLED)));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'disable':
        $num = Team::objects()->filter(array('team_id__in' => $_POST['ids']))
            ->update(array('flags' => SqlExpression::bitand(new SqlField('flags'), ~Team::FLAG_ENABLED)));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'delete':
        $i = 0;
        foreach ($_POST['ids'] as $k=>$v) {
            if (($t=Team::lookup($v))) {
                $t->delete();
                $i++;
            }
        }
        return ['ok' => $i > 0, 'num' => $i];
    }
    return ['ok' => false];
};

// ---------------------------------------------------------------- Ruoli (scp/roles.php)
$OPS['admin.role.save'] = function (array $op) {
    admin_staff($op);
    $vars = admin_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $role = Role::lookup($op['args']['id']);
        $ok = $role->update($vars, $errors);
    } else {
        $role = Role::create();
        $ok = $role->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $role->getId() : null, 'errors' => admin_errors($errors)];
};

$OPS['admin.role.mass'] = function (array $op) {
    admin_staff($op);
    $_POST = admin_post(['ids' => $op['args']['ids'], 'a' => $op['args']['a']]);
    switch (strtolower($_POST['a'])) {
    case 'enable':
        $num = Role::objects()->filter(array('id__in' => $_POST['ids']))
            ->update(array('flags'=> SqlExpression::bitor(new SqlField('flags'), Role::FLAG_ENABLED)));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'disable':
        $num = Role::objects()->filter(array('id__in' => $_POST['ids']))
            ->update(array('flags'=> SqlExpression::bitand(new SqlField('flags'), (~Role::FLAG_ENABLED))));
        return ['ok' => (bool) $num, 'num' => $num];
    case 'delete':
        $i = 0;
        foreach ($_POST['ids'] as $k=>$v) {
            if (($r=Role::lookup($v)) && $r->isDeleteable() && $r->delete())
                $i++;
        }
        return ['ok' => $i > 0, 'num' => $i];
    }
    return ['ok' => false];
};
