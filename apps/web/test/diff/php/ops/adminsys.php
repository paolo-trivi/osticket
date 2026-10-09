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
    $vars = adminsys_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $email = Email::lookup($op['args']['id']);
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
    // errori dei campi del form per nome (i campi non hanno id)
    foreach ($form->getFields() as $f)
        if ($f->errors())
            $errors[$f->get('name')] = implode(', ', $f->errors());
    return ['ok' => (bool) $ok, 'id' => $account->getId(), 'errors' => adminsys_errors($errors)];
};

/** POST simulato (alcune classi leggono $_POST direttamente). */
function adminsys_post(array $vars) {
    $_POST = $vars;
    $_REQUEST = $vars;
    $_SERVER['REQUEST_METHOD'] = 'POST';
    return $vars;
}

// ---------------------------------------------------------------- Impostazioni email (scp/emailsettings.php)
$OPS['adminsys.settings.emails'] = function (array $op) {
    global $cfg;
    adminsys_staff($op);
    $vars = adminsys_post($op['args']['vars']);
    $errors = array();
    $ok = $cfg->updateSettings($vars, $errors);
    return ['ok' => (bool) $ok, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Ban list (scp/banlist.php)
$OPS['adminsys.banlist'] = function (array $op) {
    require_once INCLUDE_DIR.'class.banlist.php';
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array();
    $filter = Banlist::getFilter();
    $rule = null;
    if ($filter && !empty($op['args']['id']) && !($rule = $filter->getRule($op['args']['id'])))
        $errors['err'] = 'unknown';
    $ok = false; $num = 0;
    if (!$errors && $filter) {
        switch (strtolower($_POST['do'])) {
        case 'update':
            if (!$rule) {
                $errors['err'] = 'unknown_rule';
            } elseif (!$_POST['val'] || !Validator::is_email($_POST['val'])) {
                $errors['err'] = $errors['val'] = 'valid_email_required';
            } else {
                $vars = array('what'=>'email', 'how'=>'equal', 'val'=>trim($_POST['val']),
                    'filter_id'=>$filter->getId(), 'isactive'=>$_POST['isactive'], 'notes'=>$_POST['notes']);
                $ok = (bool) $rule->update($vars, $errors);
            }
            break;
        case 'add':
            if (!$_POST['val'] || !Validator::is_email($_POST['val'])) {
                $errors['err'] = $errors['val'] = 'valid_email_required';
            } elseif (BanList::includes(trim($_POST['val']))) {
                $errors['err'] = $errors['val'] = 'already_banned';
            } else {
                $ok = (bool) $filter->addRule('email', 'equal', trim($_POST['val']),
                    array('isactive'=>$_POST['isactive'], 'notes'=>$_POST['notes']));
            }
            break;
        case 'mass_process':
            $count = count($_POST['ids']);
            switch (strtolower($_POST['a'])) {
            case 'enable':
            case 'disable':
                $sql = 'UPDATE '.FILTER_RULE_TABLE.' SET isactive='.($_POST['a'] == 'enable' ? 1 : 0)
                    .' WHERE filter_id='.db_input($filter->getId())
                    .' AND id IN ('.implode(',', db_input($_POST['ids'])).')';
                if (db_query($sql) && ($num = db_affected_rows()))
                    $ok = true;
                break;
            case 'delete':
                foreach ($_POST['ids'] as $k => $v) {
                    if (($r = FilterRule::lookup($v)) && $r->getFilterId() == $filter->getId() && $r->delete())
                        $num++;
                }
                $ok = $num > 0;
                break;
            }
            break;
        }
    }
    return ['ok' => $ok, 'num' => $num, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Filtri dei ticket (scp/filters.php)
$OPS['adminsys.filter.save'] = function (array $op) {
    adminsys_staff($op);
    $vars = adminsys_post($op['args']['vars']);
    $errors = array();
    if (!empty($op['args']['id'])) {
        $filter = Filter::lookup($op['args']['id']);
        $ok = $filter->update($vars, $errors);
    } else {
        $filter = new Filter();
        $ok = $filter->update($vars, $errors);
    }
    return ['ok' => (bool) $ok, 'id' => $ok ? (int) $filter->getId() : null, 'errors' => adminsys_errors($errors)];
};

$OPS['adminsys.filter.mass'] = function (array $op) {
    adminsys_staff($op);
    $_POST = adminsys_post(['do' => 'mass_process', 'a' => $op['args']['a'], 'ids' => $op['args']['ids']]);
    $num = 0;
    switch (strtolower($_POST['a'])) {
    case 'enable':
    case 'disable':
        foreach (Filter::objects()->filter(['id__in' => $_POST['ids']]) as $F) {
            $F->isactive = $_POST['a'] == 'enable' ? 1 : 0;
            if ($F->save())
                $num++;
        }
        break;
    case 'delete':
        foreach ($_POST['ids'] as $k => $v) {
            if (($f = Filter::lookup($v)) && !$f->isSystemBanlist() && $f->delete())
                $num++;
        }
        break;
    }
    return ['ok' => $num > 0, 'num' => $num];
};

// ---------------------------------------------------------------- Template email (scp/templates.php)
$OPS['adminsys.template'] = function (array $op) {
    require_once INCLUDE_DIR.'class.template.php';
    $thisstaff = adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $_REQUEST = $_POST + ($op['args']['request'] ?? []);
    $errors = array();
    $template = null;
    if ($_REQUEST['tpl_id'] && !($template = EmailTemplateGroup::lookup($_REQUEST['tpl_id'])))
        $errors['err'] = 'unknown_set';
    elseif ($_REQUEST['id'] && !($template = EmailTemplate::lookup($_REQUEST['id'])))
        $errors['err'] = 'unknown_template';
    $ok = false; $id = null; $num = 0;
    switch (strtolower($_POST['do'])) {
    case 'updatetpl':
        if (!$template) { $errors['err'] = 'unknown'; break; }
        if ($ok = (bool) $template->update($_POST, $errors)) {
            Draft::deleteForNamespace('tpl.'.$template->getCodeName().'.'.$template->getTplId());
            $id = $template->getId();
        }
        break;
    case 'implement':
        if (!$template) { $errors['err'] = 'unknown'; break; }
        if ($new = EmailTemplate::add($_POST, $errors)) {
            $ok = true; $id = $new->getId();
            Draft::deleteForNamespace('tpl.'.$new->getCodeName().$new->getTplId(), $thisstaff->getId());
        }
        break;
    case 'update':
        if (!$template) { $errors['err'] = 'unknown'; break; }
        $ok = (bool) $template->update($_POST, $errors);
        $id = $template->getId();
        break;
    case 'add':
        if ($new = EmailTemplateGroup::add($_POST, $errors)) {
            $ok = true; $id = $new->getId();
        }
        break;
    case 'mass_process':
        $count = count($_POST['ids']);
        switch (strtolower($_POST['a'])) {
        case 'enable':
            $sql = 'UPDATE '.EMAIL_TEMPLATE_GRP_TABLE.' SET isactive=1 '
                .' WHERE tpl_id IN ('.implode(',', db_input($_POST['ids'])).')';
            if (db_query($sql) && ($num = db_affected_rows()))
                $ok = true;
            break;
        case 'disable':
            foreach ($_POST['ids'] as $k => $v)
                if (($t = EmailTemplateGroup::lookup($v)) && !$t->isInUse() && $t->disable())
                    $num++;
            $ok = $num > 0;
            break;
        case 'delete':
            foreach ($_POST['ids'] as $k => $v)
                if (($t = EmailTemplateGroup::lookup($v)) && !$t->isInUse() && $t->delete())
                    $num++;
            $ok = $num > 0;
            break;
        }
        break;
    }
    return ['ok' => $ok, 'id' => $id ? (int) $id : null, 'num' => $num, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- API key (scp/apikeys.php)
$OPS['adminsys.apikey'] = function (array $op) {
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array();
    $api = !empty($op['args']['id']) ? API::lookup($op['args']['id']) : null;
    $ok = false; $id = null; $num = 0;
    switch (strtolower($_POST['do'])) {
    case 'update':
        if ($api && $api->update($_POST, $errors)) { $ok = true; $id = $api->getId(); }
        break;
    case 'add':
        if ($id = API::add($_POST, $errors)) $ok = true;
        break;
    case 'mass_process':
        switch (strtolower($_POST['a'])) {
        case 'enable':
        case 'disable':
            $sql = 'UPDATE '.API_KEY_TABLE.' SET isactive='.($_POST['a'] == 'enable' ? 1 : 0)
                .' WHERE id IN ('.implode(',', db_input($_POST['ids'])).')';
            if (db_query($sql) && ($num = db_affected_rows())) $ok = true;
            break;
        case 'delete':
            foreach ($_POST['ids'] as $k => $v)
                if (($t = API::lookup($v)) && $t->delete()) $num++;
            $ok = $num > 0;
            break;
        }
        break;
    }
    return ['ok' => $ok, 'id' => $id ? (int) $id : null, 'num' => $num, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Pagine (scp/pages.php)
$OPS['adminsys.page'] = function (array $op) {
    global $cfg;
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array();
    $page = !empty($op['args']['id']) ? Page::lookup($op['args']['id']) : null;
    $ok = false; $id = null; $num = 0; $err = null;
    switch (strtolower($_POST['do'])) {
    case 'add':
        $page = Page::create();
        if ($page->update($_POST, $errors)) {
            $ok = true; $id = $page->getId();
            Draft::deleteForNamespace('page');
        }
        break;
    case 'update':
        if ($page && $page->update($_POST, $errors)) {
            $ok = true; $id = $page->getId();
            Draft::deleteForNamespace('page.'.$page->getId().'%');
        }
        break;
    case 'mass_process':
        if (array_intersect($_POST['ids'], $cfg->getDefaultPages()) && strcasecmp($_POST['a'], 'enable')) {
            $err = 'page_in_use';
            break;
        }
        switch (strtolower($_POST['a'])) {
        case 'enable':
            $num = Page::objects()->filter(array('id__in' => $_POST['ids']))->update(array('isactive' => 1));
            break;
        case 'disable':
            foreach (Page::objects()->filter(array('id__in' => $_POST['ids'])) as $p)
                if ($p->disable()) $num++;
            break;
        case 'delete':
            foreach (Page::objects()->filter(array('id__in' => $_POST['ids'])) as $p)
                if ($p->delete()) $num++;
            break;
        }
        $ok = $num > 0;
        break;
    }
    return ['ok' => $ok, 'id' => $id ? (int) $id : null, 'num' => $num, 'error' => $err, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Log di sistema (scp/logs.php)
$OPS['adminsys.logs.delete'] = function (array $op) {
    adminsys_staff($op);
    $_POST = adminsys_post(['do' => 'mass_process', 'a' => 'delete', 'ids' => $op['args']['ids']]);
    $num = 0;
    $sql = 'DELETE FROM '.SYSLOG_TABLE.' WHERE log_id IN ('.implode(',', db_input($_POST['ids'])).')';
    if (db_query($sql)) $num = db_affected_rows();
    return ['ok' => $num > 0, 'num' => $num];
};

// ---------------------------------------------------------------- Plugin (scp/plugins.php do=mass_process enable/disable)
$OPS['adminsys.plugins'] = function (array $op) {
    require_once INCLUDE_DIR.'class.plugin.php';
    adminsys_staff($op);
    $plugins = Plugin::objects()->filter(['id__in' => array_values($op['args']['ids'])]);
    $num = $plugins->update(['isactive' => $op['args']['a'] == 'enable' ? 1 : 0]);
    PluginManager::clearCache();
    return ['ok' => true, 'num' => $num];
};

// ---------------------------------------------------------------- Liste (scp/lists.php + ajax.forms.php)
$OPS['adminsys.list'] = function (array $op) {
    require_once INCLUDE_DIR.'class.list.php';
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array();
    $list = null; $form = null; $max_sort = null;
    if (!empty($op['args']['id'])) {
        $list = DynamicList::lookup(['id' => $op['args']['id']]);
        if ($list) {
            $list = CustomListHandler::forList($list);
            $form = $list->getForm();
        }
    }
    $info = Format::htmlchars($_POST, true);
    $ok = false; $id = null; $num = 0;
    switch (strtolower($_POST['do'])) {
    case 'update':
        if ($list && $list->update($info, $errors)) {
            if ($list->getSortMode() == 'SortCol') {
                foreach ($list->getAllItems() as $item) {
                    $iid = $item->getId();
                    if (isset($info["sort-{$iid}"])) {
                        $item->sort = $info["sort-$iid"];
                        $item->save();
                    }
                }
            }
            if (!$errors && ($form = $list->getForm())) {
                $names = array();
                $fields = $form->getDynamicFields();
                foreach ($fields as $field) {
                    $fid = $field->get('id');
                    if ($info["delete-prop-$fid"] == 'on' && $field->isDeletable()) {
                        $fields->remove($field);
                        continue;
                    }
                    if (isset($info["type-$fid"]) && $field->isChangeable())
                        $field->set('type', $info["type-$fid"]);
                    if (isset($info["name-$fid"]) && !$field->isNameForced())
                        $field->set('name', $info["name-$fid"]);
                    foreach (array('sort','label') as $f)
                        if (isset($info["prop-$f-$fid"]))
                            $field->set($f, $info["prop-$f-$fid"]);
                    if (in_array($field->get('name'), $names))
                        $field->addError('not unique', 'name');
                    if (preg_match('/[.{}\'"`; ]/u', $field->get('name')))
                        $field->addError('invalid', 'name');
                    if ($field->get('name'))
                        $names[] = $field->get('name');
                    if ($field->isValid())
                        $field->save();
                    else
                        $errors["field-$fid"] = 'Field has validation errors';
                    $max_sort = max($max_sort, $field->get('sort'));
                }
            }
            if ($errors) $errors['err'] = 'items_errors';
            else { $ok = true; $id = $list->getId(); }
        }
        break;
    case 'add':
        if ($list = DynamicList::add($info, $errors)) {
            $form = $list->getForm(true);
            $ok = true; $id = $list->getId();
        }
        break;
    case 'mass_process':
        foreach ($info['ids'] as $k => $v)
            if (($t = DynamicList::lookup($v)) && $t->delete())
                $num++;
        $ok = $num > 0;
        break;
    }
    if ($form) {
        for ($i=0; isset($info["prop-sort-new-$i"]); $i++) {
            if (!$info["prop-label-new-$i"])
                continue;
            $field = DynamicFormField::create(array(
                'sort' => $info["prop-sort-new-$i"] ?: ++$max_sort,
                'label' => $info["prop-label-new-$i"],
                'type' => $info["type-new-$i"],
                'name' => $info["name-new-$i"],
                'flags' => DynamicFormField::FLAG_ENABLED
                    | DynamicFormField::FLAG_AGENT_VIEW
                    | DynamicFormField::FLAG_AGENT_EDIT,
            ));
            if ($field->isValid()) {
                $form->fields->add($field);
                $field->save();
            }
            else
                $errors["new-$i"] = $field->errors();
        }
    }
    return ['ok' => $ok, 'id' => $id ? (int) $id : null, 'num' => $num, 'errors' => adminsys_errors($errors)];
};

// Elementi delle liste (ajax.forms.php addListItem / saveListItem / disable / undisable / delete)
$OPS['adminsys.list.item'] = function (array $op) {
    require_once INCLUDE_DIR.'class.list.php';
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $list = CustomListHandler::forList(DynamicList::lookup($op['args']['list']));
    $errors = array(); $ok = false; $id = null; $num = 0;
    $fieldErrors = function ($form) {
        $out = array();
        foreach ($form->getFields() as $f)
            if ($f->errors()) $out[$f->get('name')] = implode(', ', $f->errors());
        return $out;
    };
    switch ($op['args']['action']) {
    case 'add':
        $item_form = $list->getListItemBasicForm($_POST ?: null);
        if ($_POST && ($valid = $item_form->isValid())) {
            $data = $item_form->getClean();
            if ($list->isItemUnique($data)) {
                $item = $list->addItem($data, $errors);
                if ($item->setConfiguration($_POST, $errors)) { $ok = true; $id = $item->getId(); }
            } else
                $errors['value'] = 'in use';
        } else
            $errors += $fieldErrors($item_form);
        break;
    case 'update':
        $item = $list->getItem((int) $op['args']['item']);
        $item_form = $list->getListItemBasicForm($_POST, $item);
        if ($valid = $item_form->isValid()) {
            if ($_item = DynamicListItem::lookup(array('list_id' => $list->getId(), 'value' => $item->getValue()))) {
                if ($_item && $_item->id != $item->id)
                    $item_form->getField('value')->addError('Value already in use');
            }
            if ($item_form->isValid()) {
                $basic = $item_form->getClean();
                $item->update(['name' => $basic['name'], 'value' => $basic['value'], 'abbrev' => $basic['extra']], $errors);
            }
        } else
            $errors += $fieldErrors($item_form);
        if ($valid && $item->setConfiguration($_POST)) {
            $item->save();
            $ok = true; $id = $item->getId();
        }
        break;
    case 'enable':
    case 'disable':
    case 'delete':
        foreach ($_POST['ids'] as $iid) {
            if ($item = $list->getItem((int) $iid)) {
                if ($op['args']['action'] == 'delete') $item->delete();
                else { $op['args']['action'] == 'enable' ? $item->enable() : $item->disable(); $item->save(); }
                $num++;
            } else
                break;
        }
        $ok = true;
        break;
    }
    return ['ok' => $ok, 'id' => $id ? (int) $id : null, 'num' => $num, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Form personalizzati (scp/forms.php)
$OPS['adminsys.form'] = function (array $op) {
    adminsys_staff($op);
    $form = !empty($op['args']['id']) ? DynamicForm::lookup($op['args']['id']) : null;
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array();
    $_POST = Format::htmlchars($_POST, true);
    $_POST['instructions'] = Format::htmldecode($_POST['instructions']);
    $fields = array('title', 'notes', 'instructions');
    $required = array('title');
    $max_sort = 0; $form_fields = array(); $names = array(); $num = 0;
    switch (strtolower($_POST['do'])) {
    case 'update':
        foreach ($fields as $f)
            if (in_array($f, $required) && !$_POST[$f]) $errors[$f] = 'required';
            elseif (isset($_POST[$f])) $form->set($f, $_POST[$f]);
        $form->save(true);
        foreach ($form->getDynamicFields() as $field) {
            $id = $field->get('id');
            if ($_POST["delete-$id"] == 'on' && $field->isDeletable()) {
                if ($_POST["delete-data-$id"])
                    DynamicFormEntryAnswer::objects()->filter(array('field_id'=>$id))->delete();
                $field->delete();
                continue;
            }
            if (isset($_POST["type-$id"]) && $field->isChangeable())
                $field->set('type', $_POST["type-$id"]);
            if (isset($_POST["name-$id"]) && !$field->isNameForced())
                $field->set('name', trim($_POST["name-$id"]));
            $field->setRequirementMode($_POST["visibility-$id"]);
            foreach (array('sort','label') as $f)
                if (isset($_POST["$f-$id"]))
                    $field->set($f, $_POST["$f-$id"]);
            if (in_array(strtolower($field->get('name')), $names))
                $field->addError('not unique', 'name');
            if ($form->get('type') == 'T' && $field->get('name') == 'subject') {
                if (($f = $field->getField(false)->getImpl()) && !$f->hasData())
                    $field->addError('subject', 'type');
            }
            if ($field->get('name'))
                $names[] = strtolower($field->get('name'));
            if ($field->isValid())
                $form_fields[] = $field;
            else
                $errors["field-$id"] = 'Field has validation errors';
            $max_sort = max($max_sort, $field->get('sort'));
        }
        break;
    case 'add':
        $form = DynamicForm::create();
        foreach ($fields as $f) {
            if (in_array($f, $required) && !$_POST[$f]) $errors[$f] = 'required';
            elseif (isset($_POST[$f])) $form->set($f, $_POST[$f]);
        }
        break;
    case 'mass_process':
        foreach ($_POST['ids'] as $k => $v)
            if (($t = DynamicForm::lookup($v)) && $t->delete())
                $num++;
        return ['ok' => $num > 0, 'num' => $num];
    }
    if ($form) {
        for ($i=0; isset($_POST["sort-new-$i"]); $i++) {
            if (!$_POST["label-new-$i"])
                continue;
            $field = DynamicFormField::create(array(
                'sort'=>$_POST["sort-new-$i"] ? $_POST["sort-new-$i"] : ++$max_sort,
                'label'=>$_POST["label-new-$i"],
                'type'=>$_POST["type-new-$i"],
                'name'=>trim($_POST["name-new-$i"]),
            ));
            $field->setRequirementMode($_POST["visibility-new-$i"]);
            $form->fields->add($field);
            if (in_array(strtolower($field->get('name')), $names))
                $field->addError('not unique', 'name');
            if ($field->isValid()) {
                $form_fields[] = $field;
                if ($field->get('name'))
                    $names[] = strtolower($field->get('name'));
            }
            else
                $errors["new-$i"] = $field->errors();
        }
        if (!$errors) {
            $form->save(true);
            foreach ($form_fields as $field) {
                $field->form = $form;
                $field->save();
            }
        }
    }
    if ($errors) $errors['err'] = 'validation';
    return ['ok' => !$errors, 'id' => (!$errors && $form) ? (int) $form->getId() : null, 'errors' => adminsys_errors($errors)];
};

// ---------------------------------------------------------------- Code (scp/queues.php do=mass_process)
$OPS['adminsys.queue.mass'] = function (array $op) {
    global $cfg;
    adminsys_staff($op);
    $updated = 0; $err = null;
    foreach (CustomQueue::objects()->filter(['id__in' => $op['args']['ids']]) as $queue) {
        switch ($op['args']['a']) {
        case 'enable': $queue->enable(); if ($queue->save()) $updated++; break;
        case 'disable': $queue->disable(); if ($queue->save()) $updated++; break;
        case 'delete':
            if ($queue->getId() == $cfg->getDefaultTicketQueueId()) $err = 'default_queue';
            elseif ($queue->delete()) $updated++;
        }
    }
    return ['ok' => $updated > 0, 'num' => $updated, 'error' => $err];
};

// ---------------------------------------------------------------- Diagnostica (scp/emailtest.php)
$OPS['adminsys.emailtest'] = function (array $op) {
    adminsys_staff($op);
    $_POST = adminsys_post($op['args']['vars']);
    $errors = array(); $email = null; $ok = false;
    if (!$_POST['email_id'] || !($email = Email::lookup($_POST['email_id'])))
        $errors['email_id'] = 'select';
    if (!$_POST['email'] || !Validator::is_valid_email($_POST['email']))
        $errors['email'] = 'invalid';
    if (!$_POST['subj']) $errors['subj'] = 'required';
    if (!$_POST['body']) $errors['body'] = 'required';
    if (!$errors && $email) {
        if ($email->send($_POST['email'], $_POST['subj'], Format::sanitize($_POST['body']), null, array('reply-tag'=>false))) {
            $ok = true;
            Draft::deleteForNamespace('email.diag');
        } else
            $errors['err'] = 'send_failed';
    }
    return ['ok' => $ok, 'errors' => adminsys_errors($errors)];
};
